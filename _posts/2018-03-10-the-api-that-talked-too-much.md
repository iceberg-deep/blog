---
layout: post
title: "The API That Talked Too Much"
subtitle: "HTB Node, where a chatty REST endpoint hands you every password hash, a backup file leaks the next door, and a SUID binary forgets to check where it's looking"
date: 2018-03-10 12:00:00 +0000
description: "A REST API that returns every user's password hash, a backup zip that leaks the database, and a root-owned SUID binary that trusts the shell to expand its own path."
image: /assets/og/the-api-that-talked-too-much.png
tags: [hackthebox, writeup]
---

Node is a machine that never learned to keep a secret. It runs a tidy little Express app on port 3000, the kind of single-page thing where the page is empty and all the real action happens in the API behind it. Ask that API the wrong question and it answers honestly, completely, and without checking who you are. It will read you the full user table. Hashes included. From there the box is a relay race of leaked things: a hash becomes a login, a login pulls a backup, the backup spills a database password, the database hands you a second user, and a SUID binary that was supposed to archive folders turns out to trust the shell more than it trusts itself. Nothing here is forced. Every door was left open by something that was just being helpful.

```
        N O D E   /   :3000
        ===================
        GET /api/users/latest   "sure, here's everyone"
                |  usernames + sha256 hashes, no auth
                v
        crack a hash  ->  log in as admin
                |
        GET /api/admin/backup   "here's the whole site, base64"
                |  unzip it, read the mongo string
                v
        ssh as mark  ->  inject a mongo task  ->  become tom
                |
        /usr/local/bin/backup is SUID root
        and it lets the shell pick the path for it
                                            節
```

## 0x01 · the empty room with a loud basement

Two ports. That is the whole external surface, and the smaller a surface is, the harder it leans on what little it shows you.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.2p2 Ubuntu 4ubuntu2.2
3000/tcp open  http    Node.js Express framework
```

SSH you cannot do anything with yet. Port 3000 is the box. Loading it in a browser gives you a slick profile site for a fictional social network, but the page itself is hollow. It is a single-page application, which means the HTML you see is a shell and a pile of JavaScript that fetches everything else from an API after the page loads. Picture a restaurant with no menu on the wall, just a waiter who runs to the kitchen for every question. The interesting part is not the dining room. It is the orders the waiter is willing to carry. So you read the JavaScript the page ships, and the JS is a map of every endpoint it talks to.

## 0x02 · the endpoint with no manners

The app's own scripts reference a set of API routes under `/api/users`. You do not even need a proxy to find them, they are spelled out in the client-side code, but a quick poke confirms how loose they are.

```
$ curl -s http://10.10.10.58:3000/api/users/latest | jq .
[
  { "username": "tom",  "is_admin": false,
    "password": "f0e2e750791171b0391b682ec35835bd6a5c3f7c8d1d0191451ec77b4d75f240" },
  { "username": "mark", "is_admin": false,
    "password": "de5a1adf4fedcce1533915edc60177547f1057b61b7119fd130e1f7428705f73" },
  ...
]
```

Read what just happened. An unauthenticated GET request returned usernames, an `is_admin` flag, and a full password hash for each account. The endpoint was built to feed a "latest members" widget, and to do that it handed the entire user document to anyone who asks, hash column and all. The `/api/users/` route does the same for everyone, and it includes an account the front page never mentions, an administrator named `myP14ceAdm1nAcc0uNT`.

This is the original sin of a lot of REST APIs. The backend has one user object, and it ships that whole object to the frontend, trusting the page to only display the polite fields. But the wire does not care what the page chooses to render. Think of it like a teacher who reads the entire class roster out loud, full grades and home addresses included, because she only meant to announce who was present. The information left the building the moment she opened her mouth. What the app draws on screen is cosmetics. What the API returns is the real disclosure.

The hashes are 64 hex characters, which is the fingerprint of SHA-256. No salt, no iteration count, just a raw digest. Unsalted SHA-256 over human passwords is barely a lock at all, because the same password always produces the same hash, so someone else has almost certainly cracked it already and written the answer down.

## 0x03 · three words off a shelf

You do not even need to fire up a cracker for these. Unsalted, unstretched hashes are exactly what precomputed lookup tables exist for, and a public reverse-lookup service answers most of them instantly. For the muscle memory, the offline version is the same idea.

```
$ hashcat -m 1400 hashes.txt /usr/share/wordlists/rockyou.txt
f0e2...f240:spongebob          # tom
de5a...5f73:snowflake          # mark
dffc...32fe:manchester         # myP14ceAdm1nAcc0uNT
```

`-m 1400` is hashcat's mode for raw SHA-256. Three of the four fall in seconds, and the one that matters is the admin: `manchester`. The fourth account, `rastating`, holds out, and that is fine. You only needed one with the `is_admin` flag set, because the admin login is not the prize. It is the key to a second, locked endpoint.

## 0x04 · the backup that was the whole house

Log into the web app as the admin and a new control appears, a "download backup" button. Underneath, it hits `/api/admin/backup`, an endpoint that refuses to answer unless your session is an admin session. Now that yours is, it answers with a wall of base64.

```
$ curl -s -b "session=<admin cookie>" \
    http://10.10.10.58:3000/api/admin/backup -o myplace.b64
$ base64 -d myplace.b64 > myplace.zip
$ unzip myplace.zip
[myplace.zip] password:
```

The decoded blob is a password-protected zip. The password is not in your way for long, because a zip's password can be attacked offline, against the archive itself, with no rate limit and no server watching.

```
$ zip2john myplace.zip > zip.hash
$ john --wordlist=/usr/share/wordlists/rockyou.txt zip.hash
magicword        (myplace.zip)
```

`magicword` opens it, and inside is the entire application source. This is the jackpot of any web box, because source code is where developers write down the secrets they swear they will move to a vault later and never do. The file `app.js` holds a MongoDB connection string, and a connection string is a username and password wearing a URL.

```
mongodb://mark:5AYRft73VtFpc84k@localhost:27017/myplace
```

There it is. A real password for the user `mark`, the same mark whose web hash you already cracked, except this one is the database credential and far stronger than `snowflake`. The reason it matters is the lazy habit it reveals. People reuse passwords across services the way they reuse one mug for coffee and tea. Mark's database password is also Mark's SSH password.

```
$ ssh mark@10.10.10.58
mark@node:~$ id
uid=1000(mark) gid=1000(mark) groups=1000(mark)
```

## 0x05 · a task list anyone can write to

Mark is on the box, but `user.txt` lives in `/home/tom`, owned `root:tom`, which mark cannot read. You need to become tom. The path runs back through the same MongoDB you just borrowed a password from.

The source you unzipped describes a second component, a scheduler. It is a small service that watches a Mongo collection named `tasks`, pulls whatever command string sits in each document, and runs it. That scheduler runs as tom. And mark's database credentials let mark write into that collection. Think of it like a shared to-do whiteboard where you can scribble any chore, and a worker named tom comes by every thirty seconds and does whatever the board says, no questions asked. So you scribble a chore that opens a door for you.

```
mark@node:~$ mongo -u mark -p 5AYRft73VtFpc84k localhost/scheduler
> db.tasks.insert({ "cmd": "[ reverse shell back to 10.10.14.4 on 443 ]" })
```

I am writing the payload as a bracketed description on purpose. A literal reverse shell pasted into a database is a copy-paste loaded gun, and we do not ship those. The shape is what matters: a command string the scheduler will execute as tom. Start a listener, drop the document, and within the cycle the scheduler reads the board and runs your chore.

```
$ nc -lvnp 443
connect to [10.10.14.4] from node [10.10.10.58]
tom@node:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the binary that let the shell aim for it

Now root, and this is the part of Node worth keeping. Look for files that run with elevated rights regardless of who launches them.

```
tom@node:~$ find / -perm -4000 -type f 2>/dev/null
/usr/local/bin/backup
```

`/usr/local/bin/backup` is SUID root. It is the engine behind that web download button, a small program that zips up a directory and prints the result as base64. It takes a flag, an authentication token, and a path. The token it checks against `/etc/myplace/keys`, and that key is hardcoded in the same `app.js` you already read, so you sail past the check. The interesting flaw is in how it handles the path.

The author clearly worried about abuse, because the binary screens the path argument against a blocklist. It rejects things like `;`, backticks, `$`, `..`, and literal strings such as `/root` and `/etc`. The intent is obvious. Do not let anyone back up the sensitive directories. The mistake is just as obvious once you see it. The filter checks the string after the shell has already finished mangling it, and the shell expands certain characters before the program ever sees them.

Picture a bouncer with a list of banned names who only reads the name after the coat check has already swapped your coat for a numbered tag. He is checking the tag, not you. By the time he looks, the dangerous thing has been transformed into something his list does not recognize. That is exactly the gap. The binary blocks the literal string `/root`, but the shell will happily turn a glob like `/roo?` into `/root` for you, and it does that expansion before launching the binary at all.

```
tom@node:~$ /usr/local/bin/backup -q <key> /roo?/
[ base64 of a password-protected zip of /root ]
```

The binary never saw the forbidden word `/root`. It saw `/roo?`, which is not on the list, and the shell quietly resolved that wildcard to the one matching directory on its way in. The same trick works through `*`, and a sibling path through `~` with a poisoned `HOME` does the same thing, because all of them are expansions the shell performs upstream of the filter. Pipe the base64 back through `base64 -d` into a file, unzip it with the same `magicword` the binary always uses, and `root.txt` and root's SSH key fall out the bottom.

```
tom@node:~$ /usr/local/bin/backup -q <key> /roo?/ | base64 -d > out.zip
tom@node:~$ unzip -P magicword out.zip
  inflating: root/root.txt
  inflating: root/.ssh/id_rsa
tom@node:~$ cat root/root.txt
████████████████████████████████
```

There is a harder, more glamorous route here too, a genuine return-to-libc buffer overflow against the same `backup` binary, because it `strcpy`s your path into a fixed buffer with no bounds check, and you can brute-force past ASLR by spamming it a few thousand times. It is a beautiful exercise. It is also completely unnecessary. The wildcard reads root's private key in one line, which is the lesson the box actually wants to teach.

## 0x07 · the honest caveat

Node never had a single dramatic vulnerability. It had a chain of small, reasonable decisions that each leaked one rung of a ladder. The API returned a whole user object because that was the easy way to build a widget. The backup endpoint shipped source code because backups are supposed to be complete. The connection string lived in source because it had to live somewhere, and nobody moved it. Mark reused one password across two services because remembering two is annoying. The scheduler trusted its task list because the task list was internal. The SUID binary trusted the path it was handed because filtering the obvious bad words felt like enough.

Pull the camera back and the whole machine is one mistake repeated in six costumes. Every step is a component that trusted the contents of something a stranger could influence. A field in a JSON response. A file in a zip. A row in a database. A glob on a command line. None of those are supposed to carry authority, and on Node every one of them quietly did. The wildcard bug is the sharpest version, and it is the one I would lose sleep over, because it ships green. Nothing about `/usr/local/bin/backup` is unpatched. It is a program doing exactly what it was written to do, defeated entirely by the fact that the shell rewrites an argument before the program's careful little blocklist ever gets to read it. You cannot `apt upgrade` your way out of a filter that checks the wrong copy of the string.

The fix for all of it is the same unglamorous discipline. Decide what each piece is allowed to say, and say only that. An API returns the fields the caller is entitled to, never the whole record. A secret lives in a vault, not a config file in a backup. A SUID binary takes a fully resolved, canonical path and validates that, not the raw string the shell might still be holding in its hands.

## 0x08 · outro

```
the api answered a question nobody was allowed to ask.
the backup carried the keys to the rest of the house.
one password did two jobs because two felt like too many.
the binary guarded a door while the shell walked past it.

six small kindnesses, stacked, and the last one was root.
say only what the caller is owed. resolve the path before you trust it.

read the leak. mind the wildcard. wear black.

                                                            EOF
```

---

*HTB: Node, retired 3 Mar 2018. A medium Linux box that is really a lecture on oversharing, an API that returns the whole record, a binary that trusts the shell to aim for it, and the credential reuse that stitches them together.*