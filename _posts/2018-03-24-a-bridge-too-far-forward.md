---
layout: post
title: "A Bridge Too Far Forward"
subtitle: "HTB Enterprise, where a draft post full of plaintext passwords opens three containers in a row, and a SUID binary on the bridge hands you root by way of a 212-byte overflow"
date: 2018-03-24 12:00:00 +0000
description: "A Star Trek box that leaks its own passwords through a custom WordPress plugin, lets you walk container to container on reused creds, and finishes with a textbook buffer overflow on a SUID bridge console."
image: /assets/og/a-bridge-too-far-forward.png
tags: [hackthebox, writeup]
---

Enterprise is a starship with the bridge console left unlocked. The whole box is dressed in Star Trek, but underneath the LCARS paint it is a very ordinary chain of people trusting the wrong thing. A custom WordPress plugin reads your input straight into a SQL query, so you ask the database for its own secrets and it reads them back. One of those secrets is a draft blog post titled "Passwords," sitting in the database in plaintext, which is exactly as bad as it sounds. From there you hop container to container, because the crew used the same handful of passwords everywhere, and you ride a directory that the host accidentally shared with a container straight onto the real machine. Then the box does the thing old boxes love to do. It leaves a program running as root that reads a wall of input without checking how long it is, and you reach root the way people did before stack canaries were polite.

```
        U S S   E N T E R P R I S E
        ===========================
        plugin:  SELECT ... WHERE post_name = [your input]
                 (no quotes, no cast, no manners)
                        |
                        v
        a draft titled "Passwords" reads itself aloud
                        |
              wp box  ->  joomla box  ->  host
              (same keys open every door)
                        |
                        v
        on the bridge, a root console reads 212 bytes
        into a 204-byte seat. you sit in the captain's chair.
                                            艦
```

## 0x01 · hailing frequencies

`nmap` paints a ship with a lot of decks open at once.

```
PORT      STATE SERVICE  VERSION
22/tcp    open  ssh      OpenSSH 7.4p1
80/tcp    open  http     Apache 2.4.10 (WordPress 4.8.1)
443/tcp   open  ssl/http Apache 2.4.25
8080/tcp  open  http     Apache 2.4.10 (Joomla)
32812/tcp open  unknown  (LCARS console behind xinetd)
```

The version numbers do not agree with each other. Apache 2.4.10 on one port, 2.4.25 on another, different banners, different little quirks. That mismatch is the first real tell. One physical box does not usually run three slightly different web servers by accident. You are looking at several Docker containers behind one address, each its own tiny machine, all sharing the host's front door. The TLS certificate on 443 quietly leaks the name `enterprise.local`, so that goes in `/etc/hosts` and we start knocking.

## 0x02 · the plugin that reads aloud

Port 80 is WordPress 4.8.1. `wpscan` finds a single user, `william.riker`, and a custom plugin folder called `lcars` that returns 403 when you poke it directly. Custom plugin is the magic phrase. Nobody audits the thing they wrote in a weekend. Over on 443, `feroxbuster` turns up a `/files` directory holding `lcars.zip`, and that archive is the plugin's own source code handed to you on a plate.

Reading the source, one file casts your input to an integer before using it, which is safe. The neighboring file does not.

```php
$query = $_GET['query'];
$sql   = "SELECT ID FROM wp_posts WHERE post_name = $query";
```

Your input lands in the query naked. No quotes around it, no conversion to a number, nothing. Picture a librarian who reads any note you slide across the desk out loud over the intercom, including the part where you wrote "and also announce the vault code." The note was supposed to be a book title. Because nobody put it in quotes, the database treats half of it as a command. That is SQL injection in one sentence, and this is the purest form of it.

`sqlmap` confirms three flavors of injection on that parameter and dumps the database list.

```
$ sqlmap -u "https://enterprise.local/wp-content/plugins/lcars/lcars_db.php?query=1" --batch --dbs
[*] joomla        [*] joomladb
[*] wordpress     [*] wordpressdb
[*] mysql         [*] information_schema  ...
```

## 0x03 · a draft titled passwords

Inside the WordPress database is a draft post the author never published, titled "Passwords," holding a short stack of strings in plaintext.

```
ZxJyhGem4k338S2Y
enterprisencc170
ZD3YxfnSjezg67JZ
u*Z14ru0p#ttj83zS6
```

A draft post is not magic. The author thought it was private because it was never published, but "unpublished" and "secret" are different words. The injection reads the drafts table the same as any other, so the lock was never there. The Joomla database in that same dump gives up two more users, `geordi.la.forge` and `Guinan`, their passwords hashed with bcrypt this time. Hashes you would have to crack, except you do not have to, because the plaintext list above almost certainly contains the matching passwords already. People reuse passwords like they reuse a favorite mug, and this crew is no exception.

Log into `/wp-admin` as `william.riker` with `u*Z14ru0p#ttj83zS6` and you are an administrator of the WordPress site.

## 0x04 · editing the wallpaper to run code

A WordPress admin is allowed to edit theme files from the browser, and theme files are PHP, and PHP runs on the server. That is the whole move. Appearance, then the theme editor, then the 404 template, and you paste in a tiny shell.

```php
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing that line in brackets rather than printing it, and the reason is the joke that proves the point. The real thing is about four words long, and the instant it touches disk any decent antivirus quarantines the file as malware. A backdoor short enough to tweet is still a backdoor. Trigger the modified template by visiting a page that 404s, trade the webshell up for a proper reverse shell, and you land inside the WordPress container as `www-data`.

```
[ php reverse shell back to 10.10.14.4 on 443 ]

$ id
uid=33(www-data) gid=33(www-data)
$ ls -a /
.dockerenv  bin  boot  ...
```

That `.dockerenv` file is the giveaway. You are not on the ship. You are in a lifeboat. `wp-config.php` hands over the MySQL root password, `NCC-1701E`, which is a fun trophy but the database lives in yet another container and gives you no shell.

## 0x05 · same trick, second deck

Port 8080 is Joomla, and you already pulled `geordi.la.forge` out of the database. Log into the Joomla `/administrator` panel with that account and the box repeats itself, because Joomla also lets an admin edit template PHP from the browser. Pick the Protostar template, open `error.php`, drop in a reverse shell, then request a page that errors so the template fires.

```
$ id
uid=33(www-data)  on a7018bfdc454
```

Two containers down, both opened by the same boring mistake. An admin who can edit code that runs on the server already owns that server, full stop. The "vulnerability" is a feature working as designed. The fix is to never let the browser write executable files, which both of these apps cheerfully do.

## 0x06 · the door the host left ajar

Now the part that actually escapes the lifeboat. Inside the Joomla container, check what is mounted.

```
$ mount -l | grep files
/dev/mapper/enterprise--vg-root on /var/www/html/files
$ ls -ld files
drwxrwxrwx ...  files
```

That `/files` directory, the one serving `lcars.zip` back on port 443, is mounted from the host's real disk into the container, and it is world-writable. Think of a submarine with a hatch into the engine room, except someone propped it open and the engine room is the rest of the boat. A container is supposed to be a sealed box. The moment you share a folder between the box and the host, anything you write in that folder lands on the host for real.

So write a webshell into `/files` from inside the container, sign it `iceberg.php` so you know whose it is, and then ask for it over the host's own HTTPS on 443.

```
$ echo '<?php [ webshell: run cmd ] ?>' > files/iceberg.php

https://10.10.10.61/files/iceberg.php?cmd=id
uid=33(www-data) gid=33(www-data)   www-data@enterprise
```

That hostname, `enterprise`, with no container hash after it, is the host. You are out of the lifeboat and standing on the deck, still only `www-data`, but on the real machine at last. `user.txt` is yours from here.

```
$ cat /home/jeanlucpicard/user.txt
████████████████████████████████
```

## 0x07 · the bridge console

That fifth port from the very beginning, 32812, has been waiting. It runs a SUID-root binary called `lcars`, a fake bridge console that asks for an access code. SUID-root means the program runs as root no matter who starts it, so any mistake inside it is a root-level mistake.

```
$ find / -perm -4000 -name lcars -ls 2>/dev/null
-rwsr-xr-x 1 root root 12152 /bin/lcars
```

Run it under `ltrace` and the access code falls right out of a `strcmp`, because the program compares your input to the real code in cleartext in memory.

```
$ ltrace /bin/lcars
strcmp("whatever\n", "picarda1")
```

Past the gate, one of the menu options reads input into a fixed buffer with `scanf("%s", ...)` and never checks the length. `%s` keeps reading until it hits whitespace, but the seat it reads into is only 204 bytes wide. Picture a valet who keeps stuffing coats into a coat-check cubby long after it is full, spilling them down the hallway and out the fire exit. The extra coats land somewhere important. Here, the spill lands on the saved return address, the note the program left itself saying "go back here when this function finishes." Overwrite that note and you choose where the program goes next.

## 0x08 · return to the captain's chair

`checksec` says the box has thoughtfully removed every guardrail. No stack canary to catch the overflow, and address randomization is switched off, which means libc sits at the same address every run. A pattern of bytes finds the return address at offset 212. That is eight bytes past the end of the 204-byte buffer, the exact amount of overspill it takes to reach the note.

With randomization off, you do not need to inject any code. You just point the return at functions that already live in the C library, a technique called return-to-libc. Think of it like a ransom note assembled from magazine cutouts. You are not writing new words, you are pointing at words that already exist in the book, in this order: the address of `system`, then where to go when it finishes, then a pointer to the string `"sh"` already sitting in memory. The program returns into `system("sh")` and hands you a shell as the user it runs as, which is root.

```python
payload  = b"A" * 212
payload += p32(system_addr)   # found once in gdb, ASLR off
payload += p32(exit_addr)
payload += p32(binsh_addr)    # "sh" lifted from libc

r = remote("10.10.10.61", 32812)
r.sendlineafter(b"Access Code:", b"picarda1")
r.sendlineafter(b"input:", payload)
r.interactive()
```

```
$ id
uid=0(root) gid=0(root)
$ cat /root/root.txt
████████████████████████████████
```

## 0x09 · the honest caveat

Every door on Enterprise was held open from the inside, and the lesson is which doors you can actually patch and which you cannot.

The SQL injection and the overflow are the patchable kind. Quote your inputs, or better, use a parameterized query that keeps the data and the command in separate lanes so a book title can never become an instruction. Compile the bridge console with a stack canary and leave randomization on, and the overflow turns from a five-minute exercise into a research project. Those are real fixes a developer can ship on a Tuesday.

The other failures do not patch so cleanly, and those are the ones I would lose sleep over. A draft post is not a vault, so plaintext passwords in a database are plaintext passwords to anyone who reads the database, published or not. Password reuse meant one leaked string opened three different services, because the crew treated four passwords like one. And the container that shared a writable folder with its host quietly erased the entire reason containers exist. None of that shows up in a vulnerability scan. It is architecture and habit, and you fix it by drawing hard lines on purpose, not by waiting for an update.

The pattern under the paint is always the same. Something trusted a stranger's input to stay in its lane. The plugin trusted your query to be a number. The console trusted your answer to fit the seat. The host trusted the container to stay in its box. Strip the Star Trek off and Enterprise is just trust, extended a few inches too far in four different places.

## 0x0a · outro

```
the plugin read your question as an order.
the draft kept its secret in plain sight.
four passwords opened every locked thing on the ship.
the host left a hatch open to its own engine room.

then the bridge console read 212 bytes into a 204-byte seat,
and the chair was yours.

quote the input. hash the secret. seal the hatch. wear black.

                                                            EOF
```

---

*HTB: Enterprise, retired 17 Mar 2018. A medium Linux box wearing an LCARS costume over the oldest two bugs in the book, injection and overflow, with a container that forgot it was a container. The reference write-up came years later, so treat the retirement date as a best estimate. The overflow still fires in a lab and nowhere you don't own.*