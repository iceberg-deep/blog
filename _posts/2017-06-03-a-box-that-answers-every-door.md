---
layout: post
title: "A Box That Answers Every Door"
subtitle: "HTB Beep, an old CentOS PBX that offers you so many ways in you have to pick a favorite"
date: 2017-06-03 12:00:00 +0000
description: "An ancient Elastix PBX with a directory-traversal bug that bleeds a root password into half a dozen open services, and you only have to walk through one of them."
image: /assets/og/a-box-that-answers-every-door.png
tags: [hackthebox, writeup]
---

Beep is the box that cannot say no. Scan it and a dozen ports answer at once, a whole switchboard lit up and waiting, every one of them running software old enough to have grey hair. Somewhere in that pile sits an Elastix phone system with a directory-traversal bug, and that bug reads one config file off the disk that happens to hold the administrator password in plain text. The cruel joke is that this box reuses that one password everywhere. SSH, Webmin, the database, the admin panel. Find the leak once and the machine hands you root through whichever door you feel like opening. People remember Beep for the embarrassment of riches. It is less a lock to pick than a hallway of unlocked doors, and the only hard part is deciding which one to walk through.

```
        B E E P
        =======
        a switchboard, every line ringing

        22  ssh      )))  "come in"
        80  http     )))  "come in"
        443 elastix  )))  "come in"
        10000 webmin )))  "come in"
        ...and more

        one config file leaks ONE password.
        that password opens ALL of them.
                                            鈴
```

## 0x01 · the switchboard lights up

`nmap` does not whisper here. It shouts. A wall of open ports comes back, and almost every banner is a fossil.

```
PORT      STATE SERVICE   VERSION
22/tcp    open  ssh       OpenSSH 4.3 (protocol 2.0)
25/tcp    open  smtp      Postfix smtpd
80/tcp    open  http      Apache httpd 2.2.3
110/tcp   open  pop3      Cyrus pop3d 2.3.7
143/tcp   open  imap      Cyrus imapd 2.3.7
443/tcp   open  ssl/http  Apache httpd 2.2.3 (Elastix login)
3306/tcp  open  mysql     MySQL
5038/tcp  open  asterisk  Asterisk Call Manager 1.1
10000/tcp open  http      MiniServ 1.570 (Webmin)
```

`OpenSSH 4.3` and `Apache 2.2.3` put us on CentOS 5, a release that was a museum piece even when this box was live. Browse to 443 and you meet Elastix, which is a piece of software that runs office phone systems. Think of it as the brain behind one of those desk phones with the blinking lights and the little voicemail button. It glues together a pile of web apps to manage extensions, voicemail, and call routing, and a pile of web apps means a pile of attack surface.

The lesson of the port scan is not any single service. It is the sheer count of them. Every open port is another promise the box has to keep, and this box made too many promises to keep them all safe.

## 0x02 · the file that reads itself out loud

Elastix ships a bolted-on copy of vTiger CRM, and that copy has a local file inclusion bug, CVE-2012-4869. One of its pages takes a parameter that is supposed to name a language file, then blindly opens whatever path you give it. There is no filtering of `../`, the little token that means go up a directory. So you climb out of the web folder and read any file on the disk that the web server can see.

Picture a hotel concierge who is told to fetch you a brochure by name. You ask for the brochure called `../../../the manager's private safe combination`, and instead of blinking, the concierge walks off, follows your directions literally, and comes back reading the combination aloud. The page never stopped to ask whether the name you handed it pointed somewhere it had no business going.

The file worth reading is `amportal.conf`, the master config for the phone system, because it stores the admin password in plain text. A trailing null byte (`%00`) chops off the `.php` the script tries to bolt on, so the path lands exactly on the file we want.

```
GET /vtigercrm/graph.php?current_language=
    ../../../../../../../../etc/amportal.conf%00&module=Accounts&action

# in the response body, plain as day:
AMPDBPASS=jEhdIekWmdjE
ARI_ADMIN_PASSWORD=jEhdIekWmdjE
AMPMGRPASS=jEhdIekWmdjE
```

One pull, one password. `jEhdIekWmdjE`. Hold onto it, because this box never met a service it did not want to share that password with.

## 0x03 · the password that fits every lock

Here is where Beep stops being a puzzle and starts being a confession. That password was meant for the phone system's database. But somebody, somewhere, decided that one password was easier to remember than ten, and wired it into everything.

Try it against SSH as `root`, and the front door swings open.

```
# ssh -oKexAlgorithms=+diffie-hellman-group1-sha1 \
      -oHostKeyAlgorithms=+ssh-rsa root@10.10.10.7
root@10.10.10.7's password: jEhdIekWmdjE
[root@beep ~]# id
uid=0(root) gid=0(root) groups=0(root)
[root@beep ~]# cat /root/root.txt
████████████████████████████████
```

(The extra `-oKexAlgorithms` flags are not part of the attack. They are just modern SSH holding its nose to talk to a server this old.) The user flag is sitting right there too, because we skipped the entire concept of a low-privileged user and went straight to the top.

Credential reuse is the oldest sin in the book and it is not a bug in any one program. Picture a building where the front-door key, the safe key, and the boss's office key are all cut the same. Steal one off the receptionist's desk and the whole building is yours. Nobody broke a lock. They just all shared the same key, and one of them got left on a desk where a web bug could read it.

## 0x04 · the same key, four more doors

The reason Beep is famous is that the password from section two does not just open SSH. It opens nearly everything, and any one of them is a full win. You only need one. The rest are receipts.

```
  amportal.conf leaks  jEhdIekWmdjE
            |
   +--------+--------+---------+----------+
   |        |        |         |          |
  SSH     Webmin   MySQL    Elastix    (and the
  root    :10000   root     admin       LFI itself,
  shell   root     db       panel       still open)
```

Webmin on port 10000 is the showy one. It is a web control panel that runs as root by design, a browser tab that is allowed to touch any file and run any command on the box. Log in with `root` / `jEhdIekWmdjE` and you have a graphical root shell, no exploit required. The panel was built to do exactly this. The only thing protecting it was a password, and the password was lying in a file the LFI could read.

```
POST /session_login.cgi      (Webmin, :10000)
user=root&pass=jEhdIekWmdjE   ->   authenticated as root
```

Same key, different door. This is the part that should keep an admin up at night. None of these services was broken. They all did precisely what they were told. The failure was upstream, in a single reused secret, and it cascaded through every lock that secret happened to fit.

## 0x05 · the loud doors you do not need

For completeness, Beep keeps a few more exploits on the shelf, the kind you reach for only if the quiet path is closed.

There is the FreePBX remote-code-execution path, where a SIP extension is discovered with `svwar` and an exploit script runs commands as the `asterisk` user. From there `asterisk` can run a handful of commands as root via `sudo`, and one of them is the classic escape: an old `nmap` with an interactive mode. You drop into its prompt and ask it to spawn a shell for you, which it does, as root.

```
asterisk$ sudo nmap --interactive
nmap> !sh
sh-3.2# id
uid=0(root) gid=0(root)
```

Think of `nmap --interactive` like a vending machine with a maintenance hatch left unlocked. It is a network scanner, but the old version let you type `!` and run any command from inside it. Run that vending machine as root, and its maintenance hatch is a root shell. The tool was never meant to be a door. Someone just gave it root and forgot it had a hatch.

There is also a Shellshock path (CVE-2014-6271) against the Webmin CGI, where a malformed `User-Agent` header smuggles a command into a bash environment variable, and an SMTP trick where you email a webshell to a local mailbox and then read that mailbox file through the same LFI. The webshell itself is a one-liner you would mail in, the PHP `system` call reading a request parameter, with the parameter named by spelling it as the letter `c`, then a dot, then `md`, concatenated so the two halves never sit next to each other for a lazy signature scanner to catch. Then you trigger it with a `[bracketed nc callback to 10.10.14.4]`. All of it works. None of it is necessary. The reused password already gave us root in section three.

## 0x06 · the honest caveat

It is tempting to file Beep under ancient history and move on. CentOS 5, OpenSSH 4.3, a CVE from 2012. Surely nobody runs this anymore. And the specific software is indeed gone. But the shape of the failure is not a 2017 problem, it is a forever problem, and it is sitting in a production network somewhere right now wearing newer clothes.

The bug that mattered was not the LFI. The LFI only read one file. What made that file lethal was the decision, made quietly and probably to save somebody five minutes, to use one password for the database and the admin panel and the system root account all at once. The traversal bug was the bullet. The reused credential was the reason a single bullet could hit six targets. Patch the vTiger LFI and Beep still falls the moment any one of those services leaks, because they are all the same secret in different costumes.

That is the part worth carrying out of here. A scanner will flag the old Apache and the unpatched CVE, and you will dutifully fix them. No scanner flags the human habit underneath, the tired shortcut of reusing one key everywhere because remembering ten is a pain. You cannot patch that on a Tuesday. You fix it by never letting the front-door key and the safe key be cut the same, no matter how much easier it would be.

## 0x07 · outro

```
a dozen doors, all answering at once.
one config file read itself aloud, and a password fell out.
that password fit every lock in the building.

we did not break in. we were handed a key
        that someone had quietly copied too many times.

count your doors. never reuse the key. wear black.

                                                            EOF
```

---

*HTB: Beep, retired 27 May 2017. An easy box that is really a sermon on credential reuse: one leaked password, half a dozen open doors, and the only difficulty is choosing which one to walk through.*