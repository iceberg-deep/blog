---
layout: post
title: "The Help Desk That Helped Itself Out"
subtitle: "HTB Help, where an API answers a question nobody should have asked, a help desk keeps the files it swears it rejected, and an old kernel finishes the job"
date: 2019-06-15 12:00:00 +0000
description: "An API hands over a password to anyone who asks nicely, a help-desk app keeps the very files it claims to reject, and a year-old kernel hands out root for free."
image: /assets/og/the-help-desk-that-helped-itself-out.png
tags: [hackthebox, writeup]
---

Help is a box named for a help-desk app, but the real theme is everything on it answering questions it was never asked. An API on a high port hands you a username and a password hash to anyone who knows the magic word, and the magic word is just "please describe yourself." A help-desk application takes the file you upload, decides it does not like the look of it, prints a polite refusal, and then keeps the file anyway, sitting right where you can reach it. And underneath all of it runs a kernel old enough that root is less a climb than a formality. Three layers, and not one of them needed to be forced. Each one simply offered up more than it should have, to anyone who walked up and asked.

```
        H E L P   D E S K
        =================
        :3000   "describe yourself?"   →   sure, here's my schema,
                                            my user, and his password.
                   |
        :80       "no .php files."     →   *rejects it*
                  *keeps it anyway*    →   uploads/tickets/<hash>.php
                   |
                   v
        a year-old kernel, and root
        is just the next thing it says yes to.
                                            助
```

## 0x01 · the three doors

`nmap -sC -sV` against `10.10.10.121` comes back lean. Three ports, and the odd one out is the loud one.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 7.2p2 Ubuntu (Ubuntu Linux; protocol 2.0)
80/tcp   open  http     Apache httpd 2.4.18 ((Ubuntu))
3000/tcp open  http     Node.js Express framework
```

SSH and Apache are the usual furniture. Port 3000 running Express is the thing that does not belong, the service somebody stood up in a hurry and forgot was still talking. Hit the root of port 80 and you get nothing interesting, but `gobuster` against it eventually coughs up `/support`, a stock install of HelpDeskZ. Hold that. The interesting conversation starts on 3000, where a Node app is waiting to be far too honest about itself.

## 0x02 · the api that introduced itself

Poke at port 3000 and a stray endpoint answers: `/graphql`. GraphQL is a query language for APIs, and its convenience is also its weakness. Most GraphQL servers ship with introspection turned on, a built-in feature that lets a client ask the server to describe its own entire schema. Every type, every field, every query it supports. It exists so that developer tooling can autocomplete. It also means the API will draw you a complete map of itself if you simply ask.

Think of it like walking into an office and asking the receptionist, "what questions are you allowed to answer?" and instead of pointing you to a form, she reads you the entire internal directory, every name, every extension, every field on every record. The introspection query is exactly that question.

```
$ curl -s http://10.10.10.121:3000/graphql \
    -H 'Content-Type: application/json' \
    -d '{"query":"{ __schema { types { name fields { name } } } }"}' | jq
```

The schema names a `user` type with two fields that should never have been queryable from the outside: `username` and `password`. So you ask for them directly.

```
$ curl -s http://10.10.10.121:3000/graphql \
    -H 'Content-Type: application/json' \
    -d '{"query":"{ user { username password } }"}' | jq
{
  "data": {
    "user": {
      "username": "helpme@helpme.com",
      "password": "5d3c93182bb20f07b994a7f617e99cff"
    }
  }
}
```

That password field is a 32-character hex string, which is the unmistakable shape of an MD5 hash. MD5 is a one-way function, the digital equivalent of a meat grinder. You cannot un-grind it. But you can grind a billion guesses and watch for one that comes out the same shape, which is exactly what a lookup site like crackstation does against a giant precomputed table. Paste it in and `5d3c93182bb20f07b994a7f617e99cff` falls out as `godhelpmeplz`. You now have a login for the help desk on port 80, handed to you by a different service entirely that nobody told to keep quiet.

## 0x03 · the upload it swore it rejected

There are two ways forward from here, and they branch on whether you log in at all. The clean way uses those credentials against HelpDeskZ and a blind SQL injection. The faster way ignores the credentials completely and abuses how the upload form handles files it dislikes. We will take the upload, because it is the more instructive mistake.

HelpDeskZ 1.0.2 lets anyone open a support ticket and attach a file. There is a filter that is supposed to reject dangerous file types, `.php` among them, so an attacker cannot just upload a script and run it. The catch is the order of operations. The code moves your uploaded file into its permanent home first, then checks the extension, and if the check fails it prints a refusal. What it never does is delete the file it already moved. The bouncer turns you away at the door after you have already walked in and sat down, and then never actually makes you leave.

Picture a coat check that takes your bag, hangs it on the rack, then inspects it, decides bags are not allowed, and tells you so. Your bag is still on the rack. You just need the ticket number to go get it. Here that ticket number is the filename, and the filename is not random. HelpDeskZ renames every upload to `md5(original_filename + upload_timestamp)`. You control the original filename, and the timestamp is just the server's clock at the moment of upload, which the HTTP response header tells you. So the "secret" name is fully computable.

```
$ ls -la
-rw-r--r-- 1 root root  iceberg.php   [ webshell described below, not printed ]
```

The webshell itself is one line, and I am describing it rather than printing it on purpose, because the literal string is a known-bad signature that gets a file quarantined the instant it touches disk:

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

Upload it as a ticket attachment, read the `Date:` header off the response, then walk the timestamp across a window of a few hundred seconds, hashing each candidate filename and requesting it until one returns instead of 404. A short loop does the brute force.

```
$ for t in $(seq $start $end); do
    name=$(echo -n "iceberg.php$t" | md5sum | cut -d' ' -f1)
    code=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://10.10.10.121/support/uploads/tickets/$name.php?cmd=id")
    [ "$code" = "200" ] && echo "FOUND $name.php"
  done

FOUND a3f1c0...iceberg.php
$ curl "http://10.10.10.121/support/uploads/tickets/a3f1c0...iceberg.php?cmd=id"
uid=1000(help) gid=1000(help) groups=1000(help)
```

The file the app promised to reject runs your commands as `help`. Trade the webshell up for a proper callback, [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], and you land a real session.

## 0x04 · the password that did a second shift

If you took the other branch instead, the HelpDeskZ ticket-attachment download has a blind SQL injection in its `param[]` array, the kind where the page does not show you the data but its behavior changes depending on whether your injected condition is true. Adding `and 1=1-- -` returns the attachment; `and 1=2-- -` returns an error. That difference is a single bit of leaked truth, and `sqlmap` will patiently turn thousands of those bits into the full `staff` table.

```
$ sqlmap -u "http://10.10.10.121/support/?v=view_tickets&action=ticket&param[]=4&param[]=attachment&param[]=1&param[]=6" \
    --cookie="..." --dbms=mysql --dump -T staff
```

Out comes an admin row with a SHA-1 hash, `d318f44739dced66793b1a603028133a76ae680e`, which cracks to `Welcome1`. And here is the quiet hinge of the whole box: that same password is the system password for the `help` user. People reuse passwords the way they reuse a single house key for the front door, the back door, and the shed. So whichever branch you took, you can just SSH straight in and skip the webshell entirely.

```
$ ssh help@10.10.10.121
help@help:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the kernel that never grew up

Now you are `help`, an unprivileged user, and you want root. The first thing to read is the engine's age.

```
help@help:~$ uname -a
Linux help 4.4.0-116-generic #140-Ubuntu x86_64 GNU/Linux
```

Kernel `4.4.0-116` was built in early 2018, and when this box was live that made it roughly a year stale. A kernel that old on an internet-facing machine is a gift, because the kernel is the one program on the box that runs with total authority, and a bug in it is a bug in the floor everything else stands on. This particular vintage is vulnerable to CVE-2017-16995, a flaw in the eBPF verifier.

eBPF lets user programs hand small bytecode programs to the kernel to run, and a verifier is supposed to check that bytecode for safety before it runs with kernel privileges, the way airport security is supposed to inspect a bag before it reaches the plane. The bug is a sign-handling mistake in that inspection: the verifier miscalculates the range of certain values, so a program it believes is safe can actually read and write kernel memory at will. Picture a security checkpoint that mixes up positive and negative numbers, so a bag it has logged as empty is in fact the most dangerous one in the line. Once you can write arbitrary kernel memory, you simply rewrite your own process to be root.

The public exploit is Exploit-DB 44298. Pull it onto the box, compile it with the on-box `gcc`, and run it.

```
help@help:~$ gcc 44298.c -o iceberg_kex && ./iceberg_kex
[+] Using bpf jit spray
[+] Got root
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

No race to lose, no thousand attempts, no crash. One compile, one run, and the prompt comes back as uid=0.

## 0x06 · the honest caveat

It is easy to read Help as three unrelated bugs in a row, but they rhyme, and the rhyme is the lesson. Every door on this box was a system answering a question more completely than it should have. GraphQL introspection answered "what can I ask you" with a full schema and a real password, because introspection ships on by default and nobody turned it off in production. The upload filter answered "is this file allowed" with a no, but only after already storing the file and never cleaning it up, because the check ran in the wrong order. The kernel answered "is this bytecode safe" with a yes, because its verifier did the arithmetic wrong.

Two of those three are configuration and logic, not exotic memory corruption, and that is the part worth keeping. The kernel CVE is the one that gets fixed on a Tuesday by `apt upgrade`, and it is genuinely the least interesting failure here. The introspection leak and the reject-but-keep upload are the ones that would survive every patch cycle untouched, because nothing about them is unpatched. They are decisions. An API configured to describe itself to strangers, a validator that validates after it commits, a password good enough for the database that someone also typed into a login prompt. You cannot patch a default left on or a check written in the wrong order. You can only notice it before someone else asks the question first.

## 0x07 · outro

```
the api described itself to a stranger, in full.
the form kept the file it promised to throw away.
the kernel waved through code it swore it had checked.

three yeses, none of them owed. root was just the last one.

ask less. check before you keep. wear black.

                                                            EOF
```

---

*HTB: Help, retired 8 Jun 2019. An easy Linux box that is really a lecture on systems being too forthcoming, wrapped around a help desk that keeps every file it rejects. The API still answers in a lab and nowhere you do not own.*