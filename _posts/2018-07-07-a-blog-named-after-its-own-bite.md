---
layout: post
title: "A Blog Named After Its Own Bite"
subtitle: "HTB Nibbles, an easy Linux box where a guessed password and a world-writable script eat the whole host one nibble at a time"
date: 2018-07-07 12:00:00 +0000
description: "A guessed admin password and a sudo script anyone could edit turn an easy blog box into a clean lesson on trusting your own filesystem."
image: /assets/og/a-blog-named-after-its-own-bite.png
tags: [hackthebox, writeup]
---

Nibbles is rated Easy and spends its whole life living up to the name. Nothing here is a feat of exploitation. You find a blog the front page tries to hide, guess a password a child could guess, ride a five-year-old upload bug into a webshell, and then discover the box has left a root-owned errand boy lying in the open with a sign on his back reading *edit me*. There is no clever payload. There is no memory corruption. There is just a chain of small, ordinary trusts, each one bitten through in a single move, until the host has handed you everything one nibble at a time.

```
        N I B B L E S
        =============
        GET /  →  <!-- hidden: /nibbleblog/ -->
                   |
        admin.php  →  admin : nibbles   (just... guessed)
                   |
        "My image" plugin  →  upload a .php  →  shell as nibbler
                   |
        sudo -l  →  /home/nibbler/.../monitor.sh  (rwxrwxrwx)
                   |
                   v
        you didn't break root. you edited root's own errand,
        then politely asked it to run.
                                            噛
```

## 0x01 · two ports and a comment that talks too much

`nmap` is over before it starts. Two doors, nothing exotic.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

The page on 80 is almost defiantly empty. A single cheerful "Hello world!" and nothing else. But a web page is two documents, the one it shows you and the one it tells the browser, and the second one is rarely as guarded as the first. View the source and the box trips over its own feet.

```html
<!-- /nibbleblog/ directory. Nothing interesting here! -->
```

Think of it like a person who waves you past a door while loudly insisting there is nothing behind it. The insisting is the tell. Browse to `/nibbleblog/` and a whole blog engine appears that the front page was working very hard to pretend it had never heard of.

## 0x02 · reading the engine's nameplate

Now you know the *what*, a Nibbleblog install, but not the *which*, and the version is the difference between a known hole and a wall. A little directory enumeration with `gobuster` walks the tree and turns up the files an installer leaves behind. Two of them do all the work.

```
# gobuster dir -u http://10.10.10.75/nibbleblog/ \
    -w /usr/share/wordlists/dirbuster/directory-list-2.3-medium.txt \
    -x php,txt
/README          (Status: 200)
/admin.php       (Status: 200)
/content         (Status: 301)
```

`README` prints the version in plain text, `v4.0.3`. And under `content/private/`, a file called `users.xml` sits world-readable and names the only account that matters.

```
# curl -s http://10.10.10.75/nibbleblog/content/private/users.xml
<users><user username="admin">...</user></users>
```

A username and a version number. Picture a locked office where the cleaning crew taped the staff directory to the front window and stamped the building's exact model number under it. You have not picked a single lock yet and you already know whose name is on the door and which key was cut to fit it.

## 0x03 · the password that was the box's name

The login lives at `/nibbleblog/admin.php`. You have the username, `admin`, and you need a password. There is a brute-force lockout here that punishes spraying, so the wrong instinct is to throw a wordlist at it. The right instinct is to think about the box.

The machine is called Nibbles. The blog is Nibbleblog. The user is `nibbler`. When a box leans this hard on a single word, the word is usually the answer, and it is.

```
admin : nibbles
```

That is the entire authentication step. No CVE, no token, no hash. Somebody set the password to the most obvious string in the building, and the most obvious string walked right in. It is worth sitting with how unglamorous this is, because the unglamorous version is the one that actually happens to real systems every single day.

## 0x04 · the plugin that took files at its word

Nibbleblog 4.0.3 carries **CVE-2015-6967**, an authenticated arbitrary file upload. Authenticated is the key word, and you just became authenticated for free. The hole lives in the admin panel's plugin system, specifically a feature called *My image* that is supposed to let you upload a picture for your blog. It checks that you are logged in. It does not meaningfully check that the file you handed it is actually a picture.

A file upload that fails to validate what it accepts is a butler who was told to carry your luggage to the room and never told to check what is in the bags. You hand him something that is not a picture, and he carries it inside and sets it down on a shelf where the server will happily execute it.

The luggage is a one-line PHP webshell. To keep this page from being a copy-paste backdoor, the signature is split: write the word `system`, then an open paren and quote, then `c` followed by a dot and the letters `md` concatenated together so it reads as the request parameter `cmd`, then run that parameter as a shell command. Split that way it still runs on the box but slides under lazy antivirus signature scanners that only pattern-match the whole intact string.

Upload it through the *My image* plugin, and it lands at a predictable spot under the plugin's content directory.

```
# curl "http://10.10.10.75/nibbleblog/content/private/plugins/my_image/iceberg.php?cmd=id"
uid=1001(nibbler) gid=1001(nibbler) groups=1001(nibbler)
```

Code execution as `nibbler`. To trade the clumsy URL-driven shell for a real interactive one, point the `cmd` parameter at a reverse-shell callback.

```
# curl "http://10.10.10.75/.../iceberg.php?cmd=[reverse shell: mkfifo + /bin/sh piped to nc back to 10.10.14.4 on a listener port]"
# nc -lnvp 4444
nibbler@Nibbles:/$ cat /home/nibbler/user.txt
████████████████████████████████
```

A web app that runs a file you uploaded is not really a bug in the upload code. It is the server doing exactly what an executable file in a web directory is built to do. The bug was agreeing to store something that should never have been executable in the first place.

## 0x05 · the errand boy left out in the open

`nibbler` is a normal user, and the first question a normal user asks is what they are allowed to do as somebody more important. `sudo -l` answers it.

```
nibbler@Nibbles:~$ sudo -l
User nibbler may run the following commands on Nibbles:
    (root) NOPASSWD: /home/nibbler/personal/stuff/monitor.sh
```

You are allowed to run one specific script as root, with no password. On its own that is fine, *if* the script is trustworthy and *if* you cannot change what it does. So you check both, and the second check is where the box falls over.

```
nibbler@Nibbles:~$ ls -l /home/nibbler/personal/stuff/monitor.sh
-rwxrwxrwx 1 nibbler nibbler ... monitor.sh
```

`rwxrwxrwx`. World-writable. Anyone on the box can rewrite the file, and you are running it as root. Picture a manager who signs every errand his assistant brings him without reading a word, and then leaves the assistant's notepad on a public bench overnight. Whatever you scribble on that notepad in the morning, the manager signs as if it were his own. The trust was never in the assistant. It was in a notepad anyone could reach.

So you scribble. Append a line to the script that calls back to your listener, then ask sudo to run the errand.

```
nibbler@Nibbles:~$ echo '[reverse shell: /bin/sh piped through nc back to 10.10.14.4]' >> /home/nibbler/personal/stuff/monitor.sh
nibbler@Nibbles:~$ sudo /home/nibbler/personal/stuff/monitor.sh
```

The catcher lights up as root.

```
# nc -lnvp 4445
root@Nibbles:/# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

No exploit fired. The sudo rule did precisely what it was configured to do, and the file permissions did precisely what they were set to do. The two of them just happened to add up to root.

## 0x06 · the honest caveat

It is tempting to file Nibbles under "trivial" and move on, but the privesc here is worth more than its rating, because it is not a vulnerability you patch. There is no CVE for the last step. There is no version to upgrade. A box ran `sudo` for a maintenance script, which is reasonable, and somewhere along the way that script ended up writable by everyone, which is not. Those two reasonable-sounding decisions were made by different hands at different times, and the gap between them is the whole exploit.

That gap is everywhere once you learn its shape. A `sudo` entry trusts the *contents* of a file, but file permissions decide *who gets to write those contents*, and the two are governed separately and audited separately and, far too often, by nobody at all. The same logic shows up in a cron job running a script you can edit, a systemd unit pointed at a directory you own, a root service reading a config you control. The thing with privilege almost never has the bug. The bug is that the thing without privilege got to choose what the privileged thing would do.

So the lesson Nibbles leaves on the fridge is not "patch Nibbleblog," though you should. It is this. Every time you grant `sudo` to a path, you have just promised that the path, and everything that path is allowed to read or run, is exactly as trusted as root. Go read the permissions on that path. On a bad day, the answer is `rwxrwxrwx`, and root is whoever got there first.

## 0x07 · outro

```
a page hid a blog in its own source comment.
a blog whispered its password in its own name.
a plugin ran a file it should have only framed.
a root errand sat in the open, begging to be rewritten.

nothing here needed an exploit. it needed a guess and a chmod.
you didn't break in. the box kept handing you the keys.

read the source. guess the obvious. check who can write. wear black.

                                                            EOF
```

---

*HTB: Nibbles, retired 30 Jun 2018. an easy Linux box that is really a quiet sermon on the gap between who you trust to run a thing and who you let decide what that thing does.*