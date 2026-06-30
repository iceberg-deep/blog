---
layout: post
title: "A Picture That Ran"
subtitle: "HTB Networked, where a PNG with a tail full of PHP becomes a shell, a filename becomes a command, and a space in a config file becomes root"
date: 2019-11-23 12:00:00 +0000
description: "A photo upload that runs as code, a filename that runs as a command, and a single space in a network config that runs as root."
image: /assets/og/a-picture-that-ran.png
tags: [hackthebox, writeup]
---

Networked is a box that never stops asking the same question. Three times it hands a stranger's text to something that runs text, and three times nobody checks whether the text was supposed to be a command. First a photo gallery accepts an image that is secretly a script, and runs it. Then a janitor cron sweeps the upload folder by feeding filenames straight to a shell, and a filename built like a command runs as the next user up. Then a tidy little wrapper around a network config lets a space slip past its own filter, and the space runs as root. No memory corruption, no exotic CVE chain, no twelve-hour climb. Just one mistake wearing three different costumes, and a server that keeps confusing the envelope for the letter inside it.

```
        N E T W O R K E D
        =================
        upload  →  cat.png ... <?php tail ?>   "it's an image, i swear"
                        |
                        v
        apache sees ".php" anywhere in the name and runs the tail.
                        |
        cron sweeps the folder, hands each FILENAME to a shell.
        name a file like a command, and the broom sweeps you in.
                        |
        a config wrapper allows a space. ifup reads the space.
        the space is /bin/bash. the broom wore a crown.
                                                            画
```

## 0x01 · the gallery

`nmap -sC -sV` comes back thin and a little dated. SSH, an Apache running PHP, and an HTTPS port that is closed rather than open, which is its own quiet tell.

```
PORT    STATE  SERVICE VERSION
22/tcp  open   ssh     OpenSSH 7.4
80/tcp  open   http    Apache httpd 2.4.6 (CentOS) PHP/5.4.16
443/tcp closed https
```

That `Apache 2.4.6 (CentOS) PHP/5.4.16` string pins the host to CentOS 7, an old-but-stable distro that liked to ship software a few years behind the world. Hold that thought. The website itself is a near-empty photo gallery, the kind of thing a developer throws together in an afternoon. The interesting part is not what the page shows. It is what the page lets you put on it.

A quick content scan turns up the bones of the app lying around in the open: `upload.php`, `photos.php`, an `/uploads/` directory, and the gift that makes the whole box readable, a `/backup/` folder holding `backup.tar`. Untar it and you get the source for the entire site. Picture a shop that left the architect's blueprints taped to the front window. You do not have to guess where the load-bearing walls are. You can just read them.

## 0x02 · a png with a tail

The source spells out exactly how `upload.php` decides whether to trust a file, and it leans on two checks. It looks at the MIME type, and it parses the extension. Both are fooled by the same single file.

The MIME check just asks the file what kind of thing it is and insists the answer starts with `image/`.

```php
function check_file_type($file) {
  $mime_type = file_mime_type($file);
  if (strpos($mime_type, 'image/') === 0) { return true; }
}
```

The trouble is that "what kind of thing is this" gets answered by the first few bytes of the file, the magic number. A real PNG or GIF starts with a fixed signature, and a file that starts with that signature reads as an image no matter what garbage rides behind it. So you take a genuine, valid image and you staple your PHP onto the end of it. The front of the file is a picture. The back of the file is a program. The MIME check only ever reads the front.

Think of it like a passport check that only looks at the photo page and never flips to the back. Glue a real photo page onto the front of a forged booklet and the guard waves you through, because the one thing he inspects is exactly the one thing you made authentic.

That gets the file accepted. Getting it to *run* is the extension half, and the parser here is almost comically generous.

```php
function getnameUpload($filename) {
  $pieces = explode('.', $filename);
  $name  = array_shift($pieces);
  $ext   = implode('.', $pieces);
  return array($name, $ext);
}
```

It splits the name on every dot, peels off the first chunk as the name, and glues everything else back together as the extension. Name a file `iceberg.php.png` and the "extension" it records is `php.png`, which passes the allowlist because it ends in an image type. The file lands on disk still carrying `.php` in the middle of its name. Normally that would be harmless, because the dot-png on the end means the web server should treat it as a picture and just serve the bytes.

Except this server does not. Buried in the Apache config is one lazy line.

```
AddHandler php5-script .php
```

`AddHandler` with a bare `.php` does not mean "files that end in .php." It means "files with .php anywhere in the name." Our `iceberg.php.png` has `.php` sitting right there in the middle, so Apache hands the whole file to the PHP engine, which skips over the image bytes it cannot parse and happily executes the script stapled to the tail. The webshell itself is the textbook one-liner, so picture it rather than paste it.

```php
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

Request it with a command and the gallery answers like a terminal.

```
GET /uploads/10_10_14_4.php.png?cmd=id
uid=48(apache) gid=48(apache) groups=48(apache)
```

Trade the webshell up for a real callback, [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], and you are standing on the box as `apache`, the low-privilege identity the web server runs as. A picture that ran.

## 0x03 · a filename that ran

`apache` cannot do much, so the move is to read, not to push. Poking around `/home/guly` turns up a personal crontab and the script it fires.

```
*/3 * * * * php /home/guly/check_attack.php
```

Every three minutes, as the user `guly`, the box runs a little housekeeping script that is supposed to watch the upload folder for funny business and clean it up. The intent is defensive. The implementation is the whole exploit. The dangerous line takes each filename it finds and pastes it directly into a shell command.

```php
exec("nohup /bin/rm -f $path$value > /dev/null 2>&1 &");
```

`$value` is a filename, lifted straight off disk with no quoting and no sanitizing, and then dropped into the middle of a string that gets handed to `/bin/sh`. We control the upload folder. We control filenames. So we make a filename that is secretly two commands wearing a trench coat.

This is the same disease as the upload, one layer deeper. There a picture became a program. Here a filename becomes a command line. Think of it like writing your dinner order on a sticky note, and the waiter, instead of reading it to the kitchen, tapes it directly onto the keypad of the cash register. Anything you wrote that looks like a button press gets pressed. So you write your name as a button.

```bash
touch '/var/www/html/uploads/a; [ reverse shell callback to 10.10.14.4:443 ]; b'
```

The leading `a` satisfies the `rm`, the semicolons end that command and start yours, and the trailing `b` keeps the syntax tidy. Wait out the three-minute tick, and the broom sweeps your command into a shell that runs as `guly`.

```
guly@networked $ id
uid=1000(guly) gid=1000(guly) groups=1000(guly)
guly@networked $ cat user.txt
████████████████████████████████
```

## 0x04 · a space that ran

`guly` gets one privilege, and `sudo -l` lays it out without a fight.

```
User guly may run the following commands on networked:
    (root) NOPASSWD: /usr/local/sbin/changename.sh
```

A root-owned script `guly` can run as root, no password. The script's job is to write out a network interface config, the old CentOS `ifcfg-` file, by prompting for a handful of values and appending each one. And it is careful, or it thinks it is. Every value gets checked against a regular expression before it is allowed in.

```bash
regexp="^[a-zA-Z0-9_\ /-]+$"
for var in NAME PROXY_METHOD BROWSER_ONLY BOOTPROTO; do
    read x
    echo $var=$x >> /etc/sysconfig/network-scripts/ifcfg-guly
done
/sbin/ifup guly0
```

Read that character class slowly, because the entire box ends on it. The author wanted to allow letters, digits, underscores, slashes, and hyphens. And then, right in the middle, `\ `, an escaped space. They allowed spaces into a value that gets sourced as a shell variable. An `ifcfg` file is not inert data. When `ifup` brings the interface up, the system reads that file *as a shell script*, every `NAME=value` line becoming a variable assignment evaluated by the shell. A space in a shell assignment ends the assignment and starts a new command.

So you run the script and, when it asks for one of the values, you answer with a value, a space, and a command.

```
guly@networked $ sudo /usr/local/sbin/changename.sh
interface NAME:
iceberg /bin/bash
```

That writes `NAME=iceberg /bin/bash` into the config. To the regex it is fine, every character is on the allowlist. To `ifup`, sourcing the file moments later, it reads as "set NAME to iceberg, then run /bin/bash," and `ifup` runs as root.

```
[root@networked network-scripts]# id
uid=0(root) gid=0(root) groups=0(root)
[root@networked ~]# cat /root/root.txt
████████████████████████████████
```

Think of it like a form that promises to reject anything but plain words, and then quietly leaves a blank space on the approved-characters list. A space looks like nothing. To the machine that reads the form aloud, a space is where one instruction ends and the next begins.

## 0x05 · the honest caveat

It is easy to file Networked under "easy box, old PHP, nothing to see." The specific bugs are small. The pattern behind all three is not small at all, and it is the most expensive pattern in the industry, because it is the same one every single time. Somewhere, a program took something a stranger supplied and let part of it cross the line from data into instruction. The image was supposed to be pixels. It became a script. The filename was supposed to be a label. It became a command. The config value was supposed to be a setting. It became a root shell. Three envelopes, and every time the machine reached past the paper and pulled the lever printed on the inside.

The space is the one to lose sleep over, because it is the one that looks most like diligence. There was a filter. Someone sat down and wrote a regular expression specifically to keep bad input out, which is more than most of these stories can say. And the filter shipped a space in its own allowlist, which in a file that gets evaluated as shell is the one character that matters most. You cannot fix that with a patch, because nothing is unpatched. You fix it by understanding what the data turns into downstream, and an `ifcfg` file turns into shell. An allowlist is only as safe as your honesty about where the value is going to be read, and by what. The bug was never the missing rule. The bug was the rule that felt like enough.

## 0x06 · outro

```
the picture was a program. the server ran the tail.
the filename was a command. the broom swept it home.
the setting was a shell. one space wore the crown.

three envelopes opened. each one held an order, not a letter.
nobody drew the line between the paper and the pen.

read the magic bytes. quote the filename. fear the space. wear black.

                                                            EOF
```

---

*HTB: Networked, retired 16 Nov 2019. An easy Linux box that is really three lectures on the same mistake, each in a fresh costume. A picture that ran, a name that ran, a space that ran.*