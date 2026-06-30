---
layout: post
title: "Someone Was Here First"
subtitle: "HTB Scavenger, where you inject a whois server to find a site another hacker already broke, ride their backdoor in, and reverse their own rootkit to take the root they thought they hid"
date: 2020-03-07 12:00:00 +0000
description: "A whois server with a SQL bug hands you a map of hacked sites, one of which a previous attacker already backdoored, and the rootkit they left becomes your road to root."
image: /assets/og/someone-was-here-first.png
tags: [hackthebox, writeup]
---

Scavenger is a box about arriving late to a crime scene. You break in and find that someone already broke in before you, left their fingerprints everywhere, and built a back door you can walk through if you are willing to read their notes. The front of the box is a custom whois server with a SQL injection in it, and that bug hands you a list of websites this host pretends to register. One of those sites was hacked months ago by a stranger, and the stranger was sloppy. They left a webshell, a packet capture of their own attack, a trail of plaintext passwords, and a rootkit dropped in a hidden folder. The whole back half of the box is you following another hacker's muddy footprints to the same root they reached, and the final move is reverse engineering their rootkit because they changed the secret knock and never told you. You do not out-hack the box. You out-read the person who hacked it first.

```
        S C A V E N G E R
        =================
        whois 43:  "name a domain"   you name a quote
                   the server coughs up its own SQL
                        |
                        v
        a list of sites. one already wears
        a defacement and a stranger's webshell.

        you follow their footprints:
          a pcap of their break-in
          passwords lying in the open
          a rootkit in a folder named ...

        but they changed the knock.
        so you read the binary and learn it.
                                            屍
```

## 0x01 · the seven open doors

`nmap -sCV` paints a host that is doing a lot of jobs at once, which is itself the first clue. This is not a single web app. It is a tiny hosting company.

```
PORT   STATE  SERVICE  VERSION
21/tcp open   ftp      vsftpd 3.0.3
22/tcp open   ssh      OpenSSH 7.4p1 Debian
25/tcp open   smtp     Exim smtpd 4.89
43/tcp open   whois?   SUPERSECHOSTING WHOIS server v0.6beta@MariaDB10.1.37
53/tcp open   domain   ISC BIND 9.10.3-P4
80/tcp open   http     Apache httpd 2.4.25
```

Read port 43 like a confession. Whois is the old internet phone book, the service you query to ask who owns a domain. A normal whois server reads from a flat database and hands back a name and an address. This one announces its own guts in the banner. It is a custom build, version `0.6beta`, talking to `MariaDB10.1.37`. The moment a lookup service tells you it is backed by a SQL database, you stop thinking of it as a phone book and start thinking of it as a query box with a thin coat of paint.

## 0x02 · the phone book that ran your query

Whois is just a request and a string. You send a domain name, the server looks it up. So you send a domain name with a single quote stapled to the end and watch what breaks.

```
$ whois -h 10.10.10.155 -p 43 "supersechosting.htb'"
... near ''supersechosting.htb'') limit 1 ...
```

There it is. The server took the text you sent and pasted it straight into a SQL statement, quote and all, and the database choked on the lopsided punctuation and read its own query back to you out loud. Think of it like a clerk who, instead of looking your name up on a list, reads your name into a sentence she then performs as a command. Write your name as `Bob`, she behaves. Write your name as `Bob') or 1=1#` and she performs a different sentence entirely, one that says give me everything.

```
$ whois -h 10.10.10.155 -p 43 "a') or 1=1#"
justanotherblog.htb
pwnhats.htb
rentahacker.htb
supersechosting.htb
```

`or 1=1` makes the lookup match every row, and the `#` comments out the rest of the original query so the leftover punctuation never trips it. Four domains fall out, the entire customer list of this little host. One of them is named `rentahacker.htb`, which is the box winking at you. Keep injecting and you can walk the database structure, confirm the user as `whois@localhost`, and read the `customers` table directly. The injection is not the prize. It is the map.

## 0x03 · asking the nameserver for everything

The box runs its own DNS on port 53, and the customer list told you the nameserver is `ns1.supersechosting.htb`. A DNS server is supposed to answer one question at a time, the way you ask an operator for a single phone number. But many are misconfigured to honor a zone transfer, which is the request a backup server makes to copy the entire phone book in one shot. Ask a stranger for the whole book and a careful operator says no. This one says here you go.

```
$ dig axfr supersechosting.htb @10.10.10.155
www.supersechosting.htb.
mail1.supersechosting.htb.
ftp.supersechosting.htb.
sec03.rentahacker.htb.
www.pwnhats.htb.
www.justanotherblog.htb.
```

Now you have hostnames the whois bug never mentioned, including `sec03.rentahacker.htb`. Drop them all into your hosts file so your browser can find them, and start knocking on each virtual host in turn.

## 0x04 · the site that was already robbed

`rentahacker.htb` loads a defacement. Big letters, a stranger's handle, the digital equivalent of spray paint that says someone has owned this. That subdomain from the zone transfer, `sec03`, is the interesting one. It runs a Mantis bug tracker, and buried in the comments is a previous attacker bragging about the break-in and naming the file they left behind. A short content scan with `dirsearch` or `gobuster` confirms it sitting on disk.

```
$ gobuster dir -u http://sec03.rentahacker.htb/ -w common.txt -x php
/shell.php            (Status: 200)
```

`shell.php` is not yours. It is the back door the first hacker installed, and it is parked at the front of the site for anyone who finds it. It will not answer to obvious parameters like `cmd`, though, because the stranger gave it a private name. So you fuzz the parameter itself, throwing a wordlist of common names at the page and filtering out the empty replies.

```
$ wfuzz -c -w params.txt -u "http://sec03.rentahacker.htb/shell.php?FUZZ=id" --hh 0
000000197:   200   ...   "hidden"
```

The magic word is `hidden`. The shell was never locked, only named quietly, and now you know the name.

```
$ curl -G http://sec03.rentahacker.htb/shell.php --data-urlencode "hidden=id"
uid=1003(ib01c03) gid=1004(customers) groups=1004(customers)
```

You are running commands on the box, as the web user `ib01c03`, through a door a stranger built. The shell itself is the textbook one-line PHP backdoor, <?php [ one-line webshell: run the cmd request parameter ] ?> in shape, and I am describing it rather than printing it on purpose. The instant that exact string touches disk, any honest antivirus quarantines the file, which is the funniest possible demonstration of how loaded those few words really are.

## 0x05 · the firewall that says you live here now

The natural next move is to trade this clumsy webshell for a proper reverse shell, a real prompt that calls back to your machine. You start a listener, fire the payload, and nothing comes home. The box has an `iptables` policy that drops outbound connections by default and only permits traffic on connections it already knows about. Picture a hotel where the phones can only receive calls from the front desk and the room you are standing in. You can talk to anyone who calls you, but you cannot dial out. So the [reverse shell over /dev/tcp back to 10.10.14.4 on 443] never connects, because the box will not let any process inside it open a fresh line to the outside.

That is not a wall so much as a leash, and it changes the game rather than ending it. You cannot pull a shell out, so you do all your enumeration through the webshell you already have, one `curl` at a time, reading the filesystem like a detective with a flashlight.

## 0x06 · the passwords a stranger left lying around

The previous hacker, and the company they hacked, left credentials scattered like dropped change. You read them straight out of the box through the webshell.

The Mantis config gives up the database account in cleartext.

```
$ curl -G http://sec03.rentahacker.htb/shell.php \
    --data-urlencode "hidden=cat /home/ib01c03/sec03/config/config_inc.php"
   $g_db_username = 'ib01c03';
   $g_db_password = 'Thi$sh1tIsN0tGut';
```

Mail spools are the other classic place secrets pool, because people email each other passwords and never delete the thread. The spool for the web user holds a handoff that names a fresh FTP account, and a forensic folder from the company's own incident response holds a packet capture of the original break-in. That `.pcap` is the jackpot. Open it in Wireshark or carve it with `tcpflow` and you can watch the first attacker work in slow motion, including the plaintext FTP login they used. Out of the three sources you assemble a small pile of users and passwords.

```
ib01c03 : Thi$sh1tIsN0tGut
ib01ftp : YhgRt56_Ta
ib01c01 : GetYouAH4t!
```

Spray them at FTP and the door that the firewall left open, port 21, lets you in.

```
$ ftp 10.10.10.155
Name: ib01c01
Password: GetYouAH4t!
230 Login successful.
```

The home directory of `ib01c01` holds `user.txt`, and a folder named `...`, three dots, the oldest trick for hiding a directory in plain sight because it scrolls right past a careless `ls`. Inside it sits a compiled Linux kernel module, `root.ko`. That is the rootkit the first hacker built and loaded to keep their root access. It is running on this box right now.

```
ftp> get user.txt
ftp> get .../root.ko
```

```
████████████████████████████████
```

## 0x07 · reading the stranger's rootkit

A loadable kernel module runs inside the kernel itself, with full power, and a rootkit module's whole job is to hand its owner root on demand through a secret trigger. The pcap shows the first attacker downloading a `root.c`, compiling it, and inserting it. Pull a few strings out of the binary, drop them into a search engine, and you land on the public proof of concept it was forged from. That original code creates a character device, a fake file at `/dev/ttyR0`, and watches what gets written to it. Write the correct magic word and the module promotes whatever process did the writing to uid 0. Think of it like a vending machine with a hidden override. Punch in the secret code and instead of a soda it dispenses the keys to the building.

The public version's secret code is `g0tR0ot`. But the first hacker was not careless about this one part. They changed the magic string before they compiled, so the password in the article is wrong, and writing it does nothing. This is the one place on the box you actually have to earn it, so you open `root.ko` in Ghidra or IDA and find the function that handles writes to the device.

```
; root_write — builds the secret, then compares
snprintf(magic, 8, "%s%s", part_a, part_b)
strncmp(user_input, magic, 7)
   on match:  commit_creds(prepare_creds())  with all ids = 0
```

The module assembles its magic value from two string fragments and compares it to whatever you wrote. Reading the actual disassembled bytes, not the article, the real knock is `g3tPr1v`. The escalation itself is the standard kernel two-step. `prepare_creds` mints a fresh credential structure, the code zeroes every id field in it so uid, gid, and the rest all become 0, and `commit_creds` staples that root identity onto your process. Your shell does not change accounts. Its identity card is quietly rewritten to say root.

So through the FTP session, or any shell you have on the box, you whisper the corrected knock to the device.

```
$ echo -n "g3tPr1v" > /dev/ttyR0
$ id
uid=0(root) gid=0(root) groups=0(root),1004(customers)
$ cat /root/root.txt
```

```
████████████████████████████████
```

The leash on outbound traffic never mattered, because you never needed to leave. The root you wanted was already installed by the person who got here first. You just had to figure out the knock they kept to themselves.

## 0x08 · the honest caveat

Scavenger is a box about cleaning up after yourself, told from the perspective of the person you forgot to clean up after. Almost nothing here is a fresh vulnerability you discovered. The whois injection is the only bug you find cold, and it is the classic injection confession, a service that took a stranger's text and treated part of it as a command instead of as inert data. Everything after that is you inheriting another attacker's mess. They left a webshell with a guessable name. They left passwords in a config file, in a mail spool, and in a packet capture of their own break-in that the defenders helpfully saved as evidence. They left their rootkit sitting in a folder a single `ls -a` reveals.

That is the lesson worth keeping, and it cuts at attackers and defenders alike. A compromise is not a single moment. It is a residue. Every tool you drop, every credential you reuse, every capture that records you, becomes a map for the next person who walks the same hallway, and the next person might not be on your side. The first hacker on Scavenger did the hard work of breaking in, and then handed nearly all of it to you for free by being loud about it afterward. The one thing they protected, the rootkit's magic word, is the one thing that actually slowed you down. Secrets you keep in your head are secrets. Secrets you leave on the floor belong to whoever sweeps up.

## 0x09 · outro

```
you arrived at a robbery already finished.
the thief left the window open, the notes on the table,
the back door propped, the password to the safe in a folder named ...

you read their work, fixed the one knock they changed,
and took the root they thought was theirs alone.

leave nothing behind. read everything left for you. wear black.

                                                            EOF
```

---

*HTB: Scavenger, retired 29 Feb 2020. A hard Linux box that is really a lesson in residue, where a whois injection opens the door and a sloppier hacker walks you the rest of the way to a root they reverse-engineered for you without meaning to.*