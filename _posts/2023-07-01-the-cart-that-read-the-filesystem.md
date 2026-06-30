---
layout: post
title: "The Cart That Read the Filesystem"
subtitle: "HTB Stocker, where a login that asks 'are you not this person' lets everyone in, and a shopping cart prints the server's own source code into a PDF"
date: 2023-07-01 12:00:00 +0000
description: "A login bypass made of pure logic, a checkout receipt that leaks the app's own source, and a sudo rule one asterisk too generous."
image: /assets/og/the-cart-that-read-the-filesystem.png
tags: [hackthebox, writeup]
---

Stocker is an online stock-management shop, and the whole box runs on things that were supposed to be inert handing you a lever. The login does not check your password so much as ask the database a riddle, and you answer the riddle wrong on purpose. The checkout does not just total your cart, it renders the cart into a PDF using a real browser, and that browser will happily read files off the server's own disk if you ask it inside the right HTML tag. Source code falls out of the receipt, a reused password walks you in over SSH, and a sudo rule with one asterisk too many hands you root. Nothing here is a memory-corruption magic trick. Every step is something trusted treating attacker input as instructions.

```
        S T O C K E R
        =============
        login:  username: { "$ne": "nobody" }
                "give me a user who ISN'T nobody"
                the database shrugs and returns the admin.
                        |
                        v
        cart:   title: <img onerror=read(/var/www/dev/index.js)>
                checkout renders it in a real browser.
                the receipt prints the server's own secrets.
                        |
                        v
        root:   sudo node /scripts/../../../shm/iceberg.js
                                            購
```

## 0x01 · the storefront

Two ports answer, and the box is not hiding much. A quick `nmap -sC -sV` shows SSH and a web server, nothing more.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.5
80/tcp open  http    nginx 1.18.0 (Ubuntu)
```

The web root redirects to `stocker.htb`, so the host wants name-based routing. Add it to your hosts file and the front page is a brochure for a stock-management product. Brochures are rarely the target. When a box leans this hard on a single domain, the interesting application usually lives on a subdomain the brochure never mentions, so the next move is to go knocking on names.

## 0x02 · the door behind the brochure

`ffuf` fuzzes the `Host` header against a subdomain list, asking the server "do you answer to this name" thousands of times in a row.

```
$ ffuf -u http://10.10.11.196 -H "Host: FUZZ.stocker.htb" \
    -w subdomains-top1m.txt -mc all -ac

dev      [Status: 302, Size: 28, Words: 4, Lines: 1]
```

`dev.stocker.htb` answers differently from everything else. It throws a 302 redirect where the bare IP just shows the default page, which is the server quietly admitting that name means something to it. Add `dev.stocker.htb` to your hosts file and you land on a login form for the actual stock app, the unfinished development copy that nobody meant to leave reachable.

## 0x03 · the login that asked the wrong question

The login form posts a username and password, and the obvious move is to guess. The clever move is to notice what kind of database is probably behind it. This is a Node app, and Node apps reach for MongoDB by reflex. MongoDB does not speak SQL. It speaks JSON, and JSON query objects can carry operators, little words like `$ne` meaning "not equal." That is the whole flaw.

The backend almost certainly runs something like `User.findOne({ username, password })`, looking for one record where both fields match what you typed. Normally you type a string and it compares strings. But if the server hands your raw JSON straight into that query, you can hand it an operator instead of a value. Switch the request's content type from a normal form post to `application/json` and send this.

```
POST /login HTTP/1.1
Host: dev.stocker.htb
Content-Type: application/json

{ "username": { "$ne": "iceberg" }, "password": { "$ne": "iceberg" } }
```

You are no longer saying "my password is X." You are saying "find me a user whose name is not iceberg and whose password is not iceberg." There is exactly such a user, the real admin, and the database cheerfully returns it. You are logged in as someone whose password you never knew and never needed.

Think of it like a bouncer with a guest list who, instead of checking whether your name is on it, asks "is your name *not* Steve?" You say correct, my name is not Steve, and he waves you in. He asked a question that every stranger on Earth answers the same way. The lock was real. The question it asked was useless.

## 0x04 · a cart that reads the disk

Inside, the app is a little store. You add stock items to a cart and check out, and checkout does something more interesting than it should. It posts your basket to `/api/order` as JSON and the server turns that basket into a PDF receipt. The PDF's metadata gives the trick away. The producer string reads `Skia/PDF m108`, which is Chromium's rendering engine. The server is spinning up a real headless browser, feeding it HTML built from your order, and printing the result.

That is the door. The item titles in your basket get dropped into the HTML the browser renders, and a browser does whatever HTML tells it. So you stop ordering stock and start ordering markup. Tamper with the order JSON and set a product title to an HTML payload instead of a name.

```
POST /api/order HTTP/1.1
Host: dev.stocker.htb
Content-Type: application/json

{ "basket": [ { "_id": "...", "title":
  "<iframe src=file:///etc/passwd width=900 height=900></iframe>",
  "price": 0, "amount": 1 } ] }
```

Download the receipt and the contents of `/etc/passwd` are printed right there on your invoice. The browser was told to embed a file, and `file:///` is a perfectly valid address to a browser, so it read the disk and rendered it. This is server-side request forgery in a costume. You are not the one reading the file. You convinced the server's own browser to read it and show you the picture.

Picture a copy shop where you fill out an order slip and the clerk scans whatever you staple to it. You staple a note that says "also photocopy the page taped under your own desk," and because the note is on the order slip, the clerk does it and hands you the copy. The receipt was never supposed to be a window into the building. You made it one.

Now aim it at the application's own source. The app is a Node project, so its main file is the obvious read, and that file is where every Node app keeps its secrets.

```
title:
  <iframe src=file:///var/www/dev/index.js width=900 height=900></iframe>
```

## 0x05 · the password in the source

The receipt prints `index.js`, and near the top sits the database connection string, the line that tells the app how to log into MongoDB.

```
mongoose.connect('mongodb://angoose:IHeardPassphrasesArePrettySecure@...')
```

A username, `angoose`, and a password that is a tiny joke at its own expense. On its own this only opens the database. But there is a local user named `angoose` on the box, and people reuse passwords the way they reuse a favorite mug. The database password is also the SSH password.

```
$ ssh angoose@stocker.htb
angoose@stocker:~$ cat user.txt
████████████████████████████████
```

Same key, two doors. The password that should have stayed inside one config file walked straight onto a login prompt, because one person typed it in two places.

## 0x06 · one asterisk too many

`angoose` is not root, so check what the box explicitly lets this user do. `sudo -l` lists the allowed commands.

```
angoose@stocker:~$ sudo -l
User angoose may run the following commands on stocker:
    (ALL) /usr/bin/node /usr/local/scripts/*.js
```

Read that rule slowly, because the whole privesc lives in the `*`. The intent was clearly "you may run any of our trusted scripts in `/usr/local/scripts/`." The mistake is that the wildcard matches more than filenames. It matches `../` as well. A shell expands `*.js`, but sudo matches the literal path you pass, and `/usr/local/scripts/../../../dev/shm/iceberg.js` ends in `.js` and begins with `/usr/local/scripts/`, so the rule says yes. Path traversal walks you straight out of the trusted folder and back to a file you control.

Drop a tiny Node script somewhere world-writable. It is not a shell payload, just two lines that copy bash and flip the SetUID bit so the copy runs as its owner, root.

```
$ cat /dev/shm/iceberg.js
[ node: copy /bin/bash to /tmp/iceberg, chown root, chmod 4755 ]
```

Then call it through the front door the sudo rule left open.

```
angoose@stocker:~$ sudo /usr/bin/node /usr/local/scripts/../../../dev/shm/iceberg.js
angoose@stocker:~$ /tmp/iceberg -p
# id
uid=1001(angoose) euid=0(root) gid=1001(angoose) egid=0(root)
# cat /root/root.txt
████████████████████████████████
```

The `-p` matters. A SetUID bash normally drops its borrowed privileges on startup, the way a borrowed badge gets confiscated at the desk. `-p` tells it to keep them. The script ran as root because sudo said it could, and now a root-owned bash sits waiting for anyone.

## 0x07 · the honest caveat

Nothing on Stocker is exotic, and that is exactly why it teaches well. Three times in a row, something that was supposed to be inert data got handed the keys to act. The login took a value and let it carry an operator, so a field meant to hold your name held a logic query instead. The cart took a product title and let it carry HTML, so a label meant to read "Blue Widget" told a browser to open a file. The sudo rule took a path and let it carry `../`, so a folder allowlist became the whole disk. Different layers, identical confession every time: nobody drew a hard line between what the input *says* and what the program *does* with it.

The NoSQL bypass is the one to sit with, because it is everywhere now and nobody is scared of it yet. Everyone learned to fear SQL injection and learned to pass user input as parameters instead of pasting it into a query string. Then the industry moved to databases that take JSON, and the exact same mistake got a fresh coat of paint. The fix is identical and ancient. Decide that a username is a string, force it to be a string before it ever reaches the query, and the `$ne` trick dies on the doorstep. The asterisk in the sudo rule is the same lesson at the bottom of the stack. An allowlist that does not pin down every character is not really an allowlist, it is a suggestion.

## 0x08 · outro

```
the lock asked "are you not a stranger," and every stranger said correct.
the receipt printed the building's own blueprints because you stapled
        a note to your order, and the clerk scanned the note.
a single asterisk turned "our scripts" into "every file on Earth."

three inert things, each handed a lever it was never meant to pull.

quote the string. read what you render. pin every character. wear black.

                                                            EOF
```

---

*HTB: Stocker, retired 24 Jun 2023. An easy Linux box that is really a lecture on the line between data and instructions, told three times in one afternoon. The login still says yes to everyone who isn't somebody, in a lab and nowhere you don't own.*