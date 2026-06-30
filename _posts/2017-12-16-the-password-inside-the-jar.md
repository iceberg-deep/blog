---
layout: post
title: "The Password Inside the Jar"
subtitle: "HTB Blocky, where a Minecraft mod ships its database password baked into the bytecode and the same word logs you straight into the admin's shell"
date: 2017-12-16 12:00:00 +0000
description: "A Minecraft server leaks its own database password inside a plugin jar, and the same word unlocks the admin's SSH and then root."
image: /assets/og/the-password-inside-the-jar.png
tags: [hackthebox, writeup]
---

Blocky is a Minecraft server that forgot its own admin was famous. The whole box is a kid's hobby project left running on the open internet, themed end to end around the game, right down to a user named after the man who built it. Somewhere on the web root sits a folder of server plugins, and one of those plugins is a Java jar that carries the database password compiled straight into its bytecode. You pull the jar, you read the code back out of it, and the password falls into your hand. Then comes the part that turns a leak into a takeover. That same password is also the admin's login, and the admin is allowed to do absolutely anything. Two reused words and a sudo rule with no brakes, and you walk in the front door wearing the owner's coat.

```
        B L O C K Y
        ===========
        /plugins/   →   a folder of server mods
                        one of them is a jar
                   |
        crack it open and the code reads:
            user = "root"
            pass = "8YsqfCTnv..."   ← baked in
                   |
                   v
        same word opens notch's ssh.
        notch may run ( ALL : ALL ) ALL.
        the door was never even locked.
                                            塊
```

## 0x01 · the server room

`nmap -sC -sV` comes back small and tells a story before you touch a single page.

```
PORT      STATE  SERVICE  VERSION
21/tcp    open   ftp      ProFTPD 1.3.5a
22/tcp    open   ssh      OpenSSH 7.2p2 Ubuntu 4ubuntu2.2
80/tcp    open   http     Apache httpd 2.4.18 ((Ubuntu))
25565/tcp closed minecraft
```

Read that last line twice. Port 25565 is the default Minecraft server port, and the scanner names it without being asked. It is closed now, but its presence is a fingerprint. This box is a game server, and game servers are run by enthusiasts, not by security teams. Anonymous FTP is worth a knock and answers with nothing. The real target is the website on 80, because hobby projects keep their secrets where they keep their files.

## 0x02 · the folder that should have been empty

The site is a WordPress blog, Twenty Seventeen theme, half-built, plastered with Minecraft art and a note that the server is coming soon. WordPress means content, and content means a layout you can map. Point `gobuster` at the root and the directory listing draws itself.

```
$ gobuster dir -u http://10.10.10.37 -w wordlist.txt
/wiki          (Status: 301)
/wp-content    (Status: 301)
/wp-login.php  (Status: 200)
/plugins       (Status: 301)
/phpmyadmin    (Status: 301)
/wp-includes   (Status: 301)
```

Everything there is ordinary WordPress furniture except one. `/plugins` is not a standard WordPress path, and when you open it you do not find PHP at all. You find a tiny file browser someone installed, and inside it two Java archives sitting in the open.

```
BlockCore.jar
GriefPrevention.jar
```

Those are Minecraft server mods. Think of the web root like a garage with the door rolled up. Most of it is the expected clutter, but on a shelf in the corner sit two boxes that belong to a different hobby entirely, and nobody walled them off from the street. A jar is just a zip file full of compiled Java, and anyone who can see it can take it home and pry it apart.

## 0x03 · reading the secret back out of the bytecode

Compiled code feels like a locked box to people who have never opened one, but Java barely compiles at all. It turns into bytecode that keeps the method names, the field names, and the string constants intact, which means a decompiler can reconstruct something very close to the original source. `jd-gui` opens a jar directly and shows you readable Java on the other side.

```
$ apt install jd-gui
$ jd-gui BlockCore.jar
```

Picture a jar as a sealed envelope made of frosted glass. It looks opaque, but hold it to the light and the writing inside shows through clear enough to read. Inside `BlockCore.jar` the decompiler hands back a class that connects to a database, and the connection string is not pulled from a config file or an environment variable. It is typed right into the code.

```java
String url  = "jdbc:mysql://localhost:3306/...";
String user = "root";
String pass = "8YsqfCTnvxAUeduzjNSXe22";
```

A password compiled into a program is still a password. People imagine that because the source is gone the secret is hidden, but the secret was never in the source. It was in the binary the whole time, riding along as a plain string, waiting for anyone curious enough to look. The mod's author hardcoded the MySQL root password so the plugin could talk to its own database, and shipped that decision out to the open web inside a downloadable file.

## 0x04 · the word that did two jobs

On its own that password only opens a MySQL database, and `phpmyadmin` was sitting right there in the gobuster output as the obvious place to spend it. But step back and look at the box's theme. The blog is signed by a user named `notch`, the handle of the man who created Minecraft, confirmed plainly with `wpscan` enumerating WordPress authors.

```
$ wpscan --url http://10.10.10.37 --enumerate u
[+] notch
 | Found By: Author Posts (Passive Detection)
 | Confirmed By: Login Error Messages (Aggressive Detection)
```

So there is a human account named `notch`, and there is a database password lying in the open. The question that cracks this box is whether the person who hardcoded one secret also recycled it. People reuse passwords the way they reuse a house key, the same one for the front door, the back door, and the shed. Try the database password as `notch`'s SSH login and the door swings.

```
$ sshpass -p '8YsqfCTnvxAUeduzjNSXe22' ssh notch@10.10.10.37
notch@Blocky:~$ id
uid=1000(notch) gid=1000(notch) groups=1000(notch),...
notch@Blocky:~$ cat user.txt
████████████████████████████████
```

The password that was supposed to guard a database guarded the whole user account too, because one person typed it twice and meant it both times.

## 0x05 · a sudo rule with no edges

Now look at what `notch` is permitted to do. The first command on any Linux box you land on is `sudo -l`, which asks the system to read back, in writing, exactly how much trust this account carries.

```
notch@Blocky:~$ sudo -l
User notch may run the following commands on Blocky:
    (ALL : ALL) ALL
```

There is no climb here. `(ALL : ALL) ALL` is the system telling you that `notch` may run any command, as any user, including root, with nothing standing in the way but the password you already hold. This is not a vulnerability in any program. It is a configuration that hands an ordinary account the master key and writes it down in the rulebook. Think of it like a building where the night janitor's badge opens the vault, the server room, and the CEO's office, not by mistake but by policy. The only thing between you and root is a prompt for a password you decompiled an hour ago.

```
notch@Blocky:~$ sudo su -
root@Blocky:~# id
uid=0(root) gid=0(root) groups=0(root)
root@Blocky:~# cat /root/root.txt
████████████████████████████████
```

One word, used a third time, and the box is yours from the bottom of the stack to the top.

## 0x06 · the honest caveat

It is easy to call Blocky trivial, an old toy box with a hardcoded password and a careless sudo line, fixed forever the moment someone reads a hardening guide. The specific mistakes here are small. The bug class is not. A secret compiled into a program is the single most common way credentials leak in the real world, and it leaks the same way every time. Developers treat the binary as a vault because they cannot read it at a glance, but a decompiler, a `strings` command, or a hex editor turns that vault back into a sentence. Mobile apps ship API keys this way. Firmware ships service passwords this way. Desktop installers ship signing tokens this way. The frosted glass only fools the person who never holds it to the light.

And the reuse is the hinge the whole box turns on. The hardcoded password by itself opens a database, which is bad but bounded. It became a full root compromise only because the same word was a person's login and that person could do anything. Pull either thread and the chain falls apart. Stop reusing the password and the leak stays a leak. Trim the sudo rule and the stolen login stays a login. Defenders get two separate chances to break this, and Blocky is a box about a host that took neither. The lesson is not that the password was weak. The password was long and random and fine. The lesson is that a strong secret used in three places is three doors with one key.

## 0x07 · outro

```
the mod carried its password compiled in,
and frosted glass is still glass to anyone who reads bytecode.

the same word opened the database, the account, and the crown,
because one key was cut three times.

decompile the jar. trim the sudo. never reuse the secret. wear black.

                                                            EOF
```

---

*HTB: Blocky, retired 09 Dec 2017. An easy Linux box that is really a lecture on hardcoded credentials and password reuse, wearing a Minecraft costume. The jar still reads back clean in a lab and nowhere you don't own.*