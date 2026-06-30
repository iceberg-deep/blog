---
layout: post
title: "All the Way Down"
subtitle: "HTB RopeTwo, an insane box that is really three separate exploits stacked. A browser engine bug for a shell, a heap bug for a user, a kernel bug for root."
date: 2021-01-23 12:00:00 +0000
description: "RopeTwo is three exploit-dev projects wearing one IP address. Break a patched V8 JavaScript engine for a foothold, corrupt a userland heap in a SUID binary for the next user, then pwn the kernel heap for root. The deep end of Hack The Box, mapped in plain language."
image: /assets/og/all-the-way-down.png
tags: [hackthebox, pwn, browser-exploitation, kernel, writeup]
---

RopeTwo is rated Insane, and for once the rating is honest about the whole climb instead of one clever trick. It is not a box with a hard step. It is three different exploits stacked on top of each other, and each one is the kind of thing people write a month-long blog series about. You break a web browser's engine to get on the box, you corrupt a normal program's memory to become a real user, and then you break the operating system's own core to become root. Every floor goes deeper, and the box is named for how far down it makes you go.

```
        R O P E   T W O
        ===============
        the browser     v8 bug   ->  shell as chromeuser
              |
              v
        a normal program  heap bug  ->  shell as r4j (user)
              |
              v
        the kernel itself  heap bug  ->  root

        three locks. three different keys. none of them shared.
                                            深
```

## 0x01 · recon, and a leak that hands you the blueprints

`nmap` finds a web server on 8000 and a GitLab instance on 5000. GitLab is the gift. Dig through the readable repositories and you find the source code for the thing running on 8000, which turns out to be a custom build of Chromium with its JavaScript engine, V8, patched. Somebody added a bug on purpose. You also find the website itself, and it has a spot where it renders content other people submit, which is a cross-site scripting hole waiting to happen.

That combination is the shape of the whole first act. You have the exact source of a broken browser engine, and you have a way to make a victim's browser run your code. Now you just have to weaponize the bug.

## 0x02 · the engine with a deliberate typo

Start with what a JavaScript engine is supposed to be. Think of V8 as an extremely strict translator standing between the web and the machine. You hand it JavaScript, it does the work, and it is supposed to guarantee that your script can never reach out and touch raw memory. Arrays have bounds. Numbers are numbers. Objects are objects. The translator enforces all of it so a random web page cannot run wild on your computer.

The patch on this box is a typo in the translator's rulebook. The diff in the GitLab repo weakens the engine's bounds checking on arrays, which means an array can be convinced to read and write past its real end. That single crack, an out-of-bounds read and write, is the entire foundation. Everything above it is leverage.

To even see what you are doing, you build the same patched engine locally as `d8`, the standalone V8 shell, and run it under a debugger. Now you can poke the bug and watch memory move.

## 0x03 · turning numbers into addresses

A raw out-of-bounds write is clumsy. You cannot do much by smearing bytes around blindly. So you climb a short ladder of primitives, and each rung is a tiny lie you teach the engine to believe.

The first lie is the bridge between numbers and memory. In the engine, an array of floating-point numbers and an array of objects are stored almost identically, but one holds values and the other holds pointers. If you can make the engine treat one as the other, you get two superpowers. `addrof` tells you the memory address of any object by reading its pointer back as if it were a plain number. `fakeobj` does the reverse and conjures an object at any address you choose by writing a number where a pointer should be. Modern V8 squeezes pointers down to 32 bits to save space, a trick called pointer compression, and you have to respect that math, but the idea holds.

From those two you build the real tools, an arbitrary read and an arbitrary write, the ability to read or change any byte in the process. Once you can read and write anywhere, the game is basically over, you are just doing chores. You find a region of memory the engine keeps marked as both writable and executable, you write your shellcode into it, and you point execution at it.

```
// the shape of it, not the whole exploit
let oob   = makeOOBArray();          // the patched, over-long array
let addrof = (o)  => leakPointer(oob, o);
let fakeobj = (a) => forgeObject(oob, a);
let [read, write] = buildRW(addrof, fakeobj);

write(rwxSegment, shellcode);        // your code, in a runnable spot
callInto(rwxSegment);                // and you jump to it
```

## 0x04 · the envelope

The exploit above only matters if a browser runs it. That is what the website's cross-site scripting hole is for. The bug is the bullet and the XSS is the gun. You plant your JavaScript where the site will render it, the box's own headless browser visits the page as part of the challenge, your code fires inside that browser, the V8 bug detonates, and your shellcode runs. A reverse shell comes back as `chromeuser`. First floor cleared, and you are barely started.

## 0x05 · the coat check with double tickets

Being `chromeuser` is not much. Enumerate and you find a SUID binary, a little custom program called `rshell` that runs with another user's privileges. It manages chunks of memory for you, and like LittleTommy's bank it has a heap bug, a way to use memory after it has been freed or to free it twice.

Here is the analogy that makes heap exploitation click. The heap is a coat check. You hand over a coat, you get a ticket, you come back with the ticket and get your coat. The allocator is the attendant who keeps it all straight. A heap bug is a flaw in the attendant. Maybe you can get two tickets for one coat, or a ticket for a coat that has already been handed back to someone else. Either way you end up holding a claim on memory that the program thinks belongs to its own brain.

From there the moves are a grim little dance with names that sound made up. You forge a fake chunk so the attendant hands you a coat that overlaps the program's own data. You poison the tcache, the allocator's fast lookaside list, so the next coat it hands out lands exactly where you want. You free a chunk into the unsorted bin to leak a real libc address, which tells you where the system library lives in memory, defeating the randomization that hides it. Then you overwrite a function pointer the program is about to call, the classic target being the allocator's own free hook, so the next time it cleans something up it runs your command instead. The shell comes back as `r4j`, and `user.txt` is finally yours.

```
fake chunk      ->  attendant hands you a coat over the program's data
tcache poison   ->  next coat lands exactly where you point
unsorted bin    ->  a freed chunk leaks where libc really lives
overwrite hook  ->  the cleanup routine runs your code instead
```

## 0x06 · forging a badge in the security office

Two floors down, one to go, and the last one is the operating system itself. There is a vulnerable kernel module loaded, and it has the same family of bug, a heap problem, but now the coat check is the building's security office. Winning there does not get you a better room. It lets you rewrite who counts as the owner of the building.

The target is a pair of kernel functions every privilege-escalation exploit eventually visits, `prepare_kernel_cred` and `commit_creds`. Call them in the right order and you are quite literally forging yourself a new identity badge that reads root, then handing it to your own process. To get there you defeat the kernel's address randomization, KASLR, by leaking a kernel pointer, then you build a chain of borrowed instruction snippets, a kernel ROP chain, that calls those two functions and returns cleanly so the machine does not panic. When the dust settles your shell's user id is zero.

```
leak a kernel pointer        ->  beat KASLR, learn the real addresses
build a kernel ROP chain     ->  commit_creds(prepare_kernel_cred(0))
return without a panic       ->  drop back to a shell that is now root
id  =>  uid=0(root)
████████████████████████████████
```

## 0x07 · the honest caveat

It would be dishonest to pretend this writeup is a recipe you can follow line by line. RopeTwo is three real exploit-development projects, browser, userland heap, and kernel heap, and each one is a skill people spend years getting comfortable with. What I have given you is the map, the shape of the climb and the reason each floor connects to the next. The territory is thousands of lines of fragile C and JavaScript that break if a single offset is wrong, which is exactly why the box reaches for the word Insane.

But the bones underneath are not mystical, and that is the point worth keeping. Every floor is the same confession in a different accent. Somebody trusted memory to stay what it was. The browser trusted an array to know its own length. The SUID binary trusted that a freed chunk was gone. The kernel trusted a structure it had already let go. Stack three of those trusts and you fall from a web page all the way to ring zero. The depth is not magic. It is the same small lie, told three times, to three different listeners who all believed it.

## 0x08 · outro

```
a browser believed an array about its own size.
a program believed a coat it had already given back.
a kernel believed a thing it had already freed.

three lies, three floors, one long drop to root.
none of it was magic. all of it was misplaced trust, repeated.

check your bounds. null your frees. doubt the kernel. wear black.

                                                            EOF
```

---

*HTB: RopeTwo, retired 23 Jan 2021. Insane, and it earns the badge. A browser-to-kernel climb that is really one bug class, use-after-the-fact trust, told in three languages.*
