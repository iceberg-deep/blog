---
layout: post
title: "Follow the Crumbs"
subtitle: "HTB BreadCrumbs, where the box leaks its own source one slice at a time, and every secret you steal unlocks the next drawer until the master password falls out of a database"
date: 2021-07-24 12:00:00 +0000
description: "A hard Windows box that hands you nothing whole. You read its source code through a traversal bug, forge its cookies from leaked math, and chase a trail of reused secrets all the way to a database that coughs up the admin password."
image: /assets/og/follow-the-crumbs.png
tags: [hackthebox, writeup]
---

BreadCrumbs is named like a confession. There is no single break here, no one CVE that pops a shell and ends the night. There is a trail. The box leaks its own source code one file at a time through a sloppy path check, and inside that source sits the recipe for its own cookies. You bake a session, forge a token, and walk into the admin panel. Then it gets honest about what it really is, which is a story about secrets that refused to stay put. A password in a JSON file. The same password scrawled in a Sticky Note. A second password in that same note. A localhost service that hands out an encrypted master key to anyone who asks the database nicely. Nobody on this box forces a single lock. They just keep finding the next key sitting next to the last one, and the box is generous enough to leave a crumb pointing at each drawer.

```
        B R E A D C R U M B S
        =====================
        book=..\..\source.php   "read me my own recipe"
                  |
                  v
        the recipe is the cookie algorithm.
        forge a session. forge a token. admin.
                  |
                  v
        json  ->  sticky note  ->  localhost db
        each crumb is a password the last one pointed to,
        and the last crumb is the master key itself.
                                            麭
```

## 0x01 · the bakery counter

Fifteen ports answer, which on a Windows box is just the machine clearing its throat. SSH at the top, a full web stack, the SMB trio, MySQL exposed, and the usual high-numbered RPC chatter. A quick `nmap -sC -sV` against `10.10.10.228` finds the part worth caring about up front.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH for_Windows_8.1
80/tcp   open  http     Apache httpd 2.4.46 ((Win64) OpenSSL/1.1.1h PHP/8.0.1)
443/tcp  open  ssl/http Apache httpd 2.4.46
445/tcp  open  microsoft-ds
3306/tcp open  mysql    MariaDB
```

Apache and PHP on Windows means XAMPP, the develop-on-your-laptop stack that has no business facing the internet. The site is a library app, books and a login portal. The portal even publishes a staff roster at `/portal/php/admins.php`, a tidy list of usernames (paul, olivia, john, juliette, and friends) that the box clearly wants you to keep. A username is half a credential. Hold the list.

## 0x02 · reading the recipe

The book search posts to `/includes/bookController.php` with a `book` parameter, and the app builds a file path out of it by gluing your input onto a `../books/` prefix. The intent was to read a book file. The mistake is that it never checks whether your input climbs back out of that folder. Feed it `..\` sequences and the path walks up and out, and the app cheerfully reads whatever PHP file you name and hands you the raw text.

Think of it like a librarian who will fetch any book on the shelf you point at, except the shelf has no back wall, and if you point past it she will happily walk into the staff office and read you the employee handbook out loud. The handbook was never meant for you. She just never learned where the shelf ended.

```
POST /includes/bookController.php
book=..\includes\bookController.php&method=1
```

One mercy for the defender lives in the details. The app uses `file_get_contents()`, which reads a file as inert text, not `include()`, which would execute it. So this is a source leak, not code execution. That sounds like a downgrade until you realize the source code is where the box keeps its secrets, and we are about to read every one of them.

## 0x03 · baking a session from the leak

Pull `/portal/cookie.php` through the traversal and the box hands you the literal algorithm that mints its session cookies.

```php
function makesession($username){
    $max  = strlen($username) - 1;
    $seed = rand(0, $max);
    $key  = "s4lTy_stR1nG_".$username[$seed]."(!528.\/9890";
    return $username . md5($key);
}
```

Stare at the `$seed`. It is a random number between zero and the length of the username, used to pick one character out of that same username and stir it into the hash. The author thought randomness made this strong. It did the opposite. For a username with N letters there are only N possible cookies in the entire universe, one per character position, and you already know the username from the staff roster. You do not brute force a hash space. You compute all eight or nine candidates and try each.

Picture a combination lock where the dial only has as many numbers as the owner's first name has letters. Randomly spinning it feels secure to the person who built it. To anyone holding the name, it is a five-second guessing game.

```
$ python3 forge.py paul
paul47200b180ccd6835d25d034eeb6e6390
```

There is a second token too. The leaked source carries a hardcoded JWT secret, a long hex string sitting right there in the file, signing `token` cookies with HS256. A signing secret is only a secret while it stays hidden. Once it is in your hands you sign your own token claiming whatever username you like, change the payload to an admin, and the server validates it because the math checks out. The signature was never proving who you are. It was only proving someone knew the secret, and now that is you.

## 0x04 · the shell that had to hide

Admin in the portal unlocks a file upload at `/portal/includes/fileController.php`. The obvious move is a PHP webshell, and the obvious move is exactly what Windows Defender is waiting for. Drop the textbook one-liner and Defender eats it off the disk before it ever runs. The filter on the app pins a `.zip` onto your name client-side, and the signature engine flags the usual payload string.

So you stop writing the famous shell and write a quieter one. Swap the flagged function for a less notorious cousin, keep it small, name the file something the filter will pass, and land it in the uploads directory.

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing it in a bracket instead of printing it, and that bracket is the whole point, not coyness. The literal four-word PHP shell is so well known that writing it to disk is itself the thing antivirus hunts for. The funniest proof of how dangerous the string is, is that you cannot save it next to a scanner without the scanner deleting it. So picture it. The real thing is shorter than this sentence.

```
$ curl http://10.10.10.228/portal/uploads/iceberg.php?cmd=whoami
breadcrumbs\www-data
```

`www-data` on Windows, the low-rent account Apache runs as. Trade up to a proper shell if you want comfort, but you barely need one. From here the box is a file-reading exercise.

## 0x05 · the crumb in the json

The portal stores user data on disk, and one folder, `pizzaDeliveryUserData`, keeps a JSON file per person. `juliette.json` is not subtle.

```
C:\xampp\htdocs\portal\pizzaDeliveryUserData\juliette.json
   "username": "juliette",
   "password": "jUli901./())!"
```

A plaintext password in a web root is the original sin of every app that grew up too fast. SSH is open, so that credential is not just a login to some web form, it is a key to the actual host.

```
$ ssh juliette@10.10.10.228
juliette@BREADCRUMBS C:\Users\juliette> type Desktop\user.txt
████████████████████████████████
```

## 0x06 · the note nobody should have written

juliette is not admin, so you go looking for where this user keeps the things they meant to remember. On Windows, that is often Sticky Notes, and Sticky Notes does not store its notes as cozy little squares. It stores them in a SQLite database, plaintext, sitting in the user's AppData.

```
C:\Users\juliette\AppData\Local\Packages\
   Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe\LocalState\plum.sqlite
```

Copy the `.sqlite` file along with its `-wal` and `-shm` companions (the database keeps recent writes in those side files, and skipping them means reading a stale note), then open it and read the Note table.

```
sqlite> SELECT Text FROM Note;
juliette: jUli901./())!
development: fN3)sN5Ee@g
administrator: [ moved to the password manager ]
```

There it is, a second password and a breadcrumb in the same breath. The `development` credential is new, and the admin line is a literal note saying the real secret moved somewhere else. Think of it like finding a sticky note on a monitor that reads "bank PIN is now in the safe." It is not the prize. It is a signpost, and it is pointing at the safe.

## 0x07 · the safe on localhost

A look at listening ports finds TCP 1234 bound to `127.0.0.1` and nothing else. A service the box runs only for itself, a password manager under development, sitting on the loopback where the firewall can never see it. That is the safe the note mentioned. You cannot reach it from outside, but you are already inside, so you forward it out. The cleanest way is to ride your existing SSH session and pull the local port back to your own machine.

```
$ ssh -L 1234:127.0.0.1:1234 juliette@10.10.10.228
$ curl http://127.0.0.1:1234/ -d "username=admin"
```

Picture a wall safe with no keyhole on the outside, reachable only from a phone that lives inside the locked house. Useless to a burglar at the window. But you are standing in the living room now, so you run a long cable from the safe out through the mail slot and crack it from the porch.

## 0x08 · the database that overshared

The password manager queries MySQL with your `username` straight inside the SQL string, unescaped. That is the bug that has outlived every framework meant to kill it. Close the quote, bolt on a `UNION SELECT`, and the query you hijack returns the rows it was supposed to protect.

```
username=' UNION SELECT concat_ws(', ',id,account,password,aes_key) FROM passwords;-- -
```

The `passwords` table stores the administrator entry as an encrypted blob next to its own AES key, which is roughly like locking a diary and taping the key to the cover. Out come both halves.

```
account:   administrator
password:  H2dFz/jNwtSTWDURot9JBhWMP6XOdmcpgqvYHG35QKw=
aes_key:   k19D193j.<19391(
```

The encryption is AES in CBC mode with an all-zero IV, and the key is sixteen bytes, so AES-128. None of that matters once you hold the key, because encryption only buys you anything while the key stays somewhere the attacker is not. Here the key shipped in the same row as the ciphertext. Feed both to any AES tool and the master falls out.

```
$ echo 'H2dFz/jNwtSTWDURot9JBhWMP6XOdmcpgqvYHG35QKw=' | base64 -d \
  | openssl enc -d -aes-128-cbc -K 6b3139443139336a2e3c3139333931... -iv 0
p@ssw0rd!@#$9890./
```

That is the administrator password, in plaintext, the thing the Sticky Note promised had been "moved." It only ever moved from a note to a database that handed it right back.

```
$ ssh administrator@10.10.10.228
administrator@BREADCRUMBS C:\Users\Administrator> type Desktop\root.txt
████████████████████████████████
```

## 0x09 · the honest caveat

Every door on BreadCrumbs was a feature shipped before it was finished, and the shape of the whole box is one idea wearing five costumes. A secret is only a secret while it stays in exactly one place that the attacker cannot reach. The traversal bug broke that by handing out the source. The cookie algorithm broke it again by being computable from a name. The JSON file, the Sticky Note, and the database each broke it the laziest way possible, by writing a secret down somewhere a foothold could read it.

People file SQL injection and directory traversal under "old bugs, surely solved." The injection here is a 1998 mistake still breathing in 2021, sure, and a prepared statement kills it in one line. But the part I would lose sleep over is not the injection. It is the habit underneath every step, the instinct to keep a key next to the lock it opens. A password in the web root. A signing secret in the source it signs. An AES key in the same database row as the ciphertext. You cannot patch your way out of that, because nothing here was unpatched. Someone simply decided, five separate times, that the secret would be safe right next to the thing it was guarding. The trail of crumbs was never the box's design. It was the sum of five people being human in the same direction.

## 0x0a · outro

```
the box read you its own recipe, and the recipe was the lock.
every secret pointed at the next one,
laid down like crumbs by people who only meant to remember.

nothing here was forced. it was all written down,
each key resting a half-inch from its lock.

read the source. doubt the cookie. never store the key beside the door. wear black.

                                                            EOF
```

---

*HTB: BreadCrumbs, retired 17 July 2021. A hard Windows box that is really a lecture on secrets that would not stay put, dressed as a library app. Read the source, forge the session, and follow the trail to a password the database was happy to decrypt for you.*