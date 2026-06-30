---
layout: post
title: "A Mailbox of Your Own"
subtitle: "HTB Delivery, where a free support ticket hands you a company email address, and one password reused across the building hands you root"
date: 2021-05-29 12:00:00 +0000
description: "A help desk gives every stranger a working company mailbox, and a chat server trusts that mailbox enough to let you read the staff room. The rest is one password worn in a few different costumes."
image: /assets/og/a-mailbox-of-your-own.png
tags: [hackthebox, writeup]
---

Delivery is a box about trust that was handed out for free. There is no exploit here in the usual sense, no overflow, no CVE you fire like a gun. You open a support ticket, and the help desk politely gives you a working email address on the company's own domain. The chat server, seeing that company address, decides you must be staff and lets you walk into the back room. Inside the back room, an admin has left a note. The note tells you a password, and then it tells you, almost as a courtesy, how the rest of the passwords on the box are built. Everything after that is just trying the same key in a few different locks. The whole climb is the box trusting paperwork instead of people.

```
        D E L I V E R Y
        ===============
        open a ticket  →  "here, use 1234567@delivery.htb"
                          a real mailbox. yours. for free.
                |
                v
        mattermost sees @delivery.htb and thinks: staff.
        the verify mail lands in YOUR ticket. you click it.
                |
                v
        in the staff chat, a note:
        "ssh here. and we all reuse one password."
        the note was the exploit.
                                            郵
```

## 0x01 · the front counter

Three ports answer, and they tell a tidy little story before you touch anything.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.9p1 Debian 10+deb10u2
80/tcp   open  http    nginx 1.14.2
8065/tcp open  http    Mattermost
```

SSH on 22 is the back door for later. nginx on 80 is the storefront. The odd one is 8065, an unusual high port running Mattermost, which is an open-source team chat tool, basically a self-hosted Slack. The web site on 80 points you toward a help desk at `helpdesk.delivery.htb` and a chat server at `delivery.htb:8065`, so the first chore is the boring one. Add both names to your hosts file, because the box serves different pages depending on the name you ask for, and an IP alone gets you the lobby instead of the actual rooms.

```
# echo "10.10.10.222 delivery.htb helpdesk.delivery.htb" >> /etc/hosts
```

The help desk runs osTicket, a common open-source ticketing system. The Mattermost server greets you with a sign-up page that wants an email address ending in `@delivery.htb`. Hold those two facts next to each other, because the entire foothold lives in the gap between them.

## 0x02 · a mailbox for the asking

The Mattermost door has a velvet rope. It will only let you register with a `@delivery.htb` email, and you do not own that domain. That looks like a wall. It is actually a misunderstanding the box is about to exploit on your behalf.

Open a ticket on the help desk. You do not need an account, you do not need to prove who you are, you just describe a problem and submit. osTicket files your complaint and, to let you keep talking to it without making an account, hands you a per-ticket email address shaped like `1234567@delivery.htb`, plus a number to check the ticket's status. Read that carefully. The help desk just gave a total stranger a live, working mailbox on the company's own domain, and any mail sent to that address shows up as a message inside your ticket.

Picture a building lobby where the receptionist, instead of asking who you are, simply clips a visitor badge on you that says STAFF and waves you through. The badge is real. The system that issued it never checked whether you deserved it. That visitor email is exactly that badge.

So you take the badge to the chat server. Register on Mattermost using your shiny `1234567@delivery.htb` address.

```
# the helpdesk ticket gives you an address like this:
1234567@delivery.htb

# register on mattermost with it, then watch the ticket
http://delivery.htb:8065/signup_email
```

Mattermost does what every sign-up does. It mails a verification link to the address you gave, to confirm you can read mail there. And you can read mail there, because that mailbox is wired straight into your osTicket conversation. The verification email lands inside your own ticket. You open the ticket, click the link, and your account is confirmed. The chat server believed the domain on the envelope and never once asked whether you actually belonged to the company.

## 0x03 · the note in the staff room

Logged into Mattermost, you are no longer an outsider. You are in the team chat, reading conversations meant for employees. And in the Internal channel sits the kind of message that gets boxes retired.

```
We have a new server. Please use the credentials:
    maildeliverer : Youve_G0t_Mail!

Also: keep in mind, our passwords all contain
some variation of "PleaseSubscribe!". Once we
fix the message-board software we'll rotate them.
```

Two gifts in one paragraph. The first is a literal username and password handed over in plaintext. The second is quieter and far more dangerous. It is a person describing, out loud, the shape of every secret on the box. They are telling you that the staff reuse one base word and just decorate it a little. Keep that sentence. It is the master key drawn in pencil, and you will trace over it in the privesc.

SSH in with the credentials from the chat.

```
# sshpass -p 'Youve_G0t_Mail!' ssh maildeliverer@10.10.10.222
maildeliverer@Delivery:~$ id
uid=1000(maildeliverer) gid=1000(maildeliverer)
maildeliverer@Delivery:~$ cat user.txt
████████████████████████████████
```

No exploit fired. You opened a ticket, borrowed the mailbox it gave you, and walked through a door that was only ever guarded by an email domain.

## 0x04 · the config that talks too much

`maildeliverer` is a normal user with nothing special, so you go looking where self-hosted apps always spill, in their own config files. Mattermost keeps its settings in one big JSON file, and that file has to know how to reach its database, which means it has to store the database password in the clear.

```
maildeliverer@Delivery:~$ cat /opt/mattermost/config/config.json | grep -i datasource
"DataSource": "mmuser:Crack_The_MM_Admin_PW@tcp(127.0.0.1:3306)/mattermost?...",
```

There it is, sitting in plain text. A user `mmuser`, a password, and the name of the database. The password string itself is a wink from the box, `Crack_The_MM_Admin_PW`, but it is also just the real working credential. Log into MySQL with it and read the Users table, because Mattermost stores every account's password hash right there.

```
maildeliverer@Delivery:~$ mysql -u mmuser -pCrack_The_MM_Admin_PW mattermost
MariaDB [mattermost]> select Username, Password from Users;
+---------------+--------------------------------------------------------------+
| Username      | Password                                                     |
+---------------+--------------------------------------------------------------+
| root          | $2a$10$VM6EeymRxJ29r8Wjkr8Dtev0O.1STWb4.4ScG.anuu7v0EFJwgjjO |
+---------------+--------------------------------------------------------------+
```

That `$2a$10$` prefix is bcrypt, a deliberately slow hashing scheme. Think of bcrypt as a lock with a built-in delay, the kind that takes a full second to turn no matter how strong your hand is. You cannot file through it by brute force, because every single guess costs you that same maddening second. Try to spray ten million random passwords at it and you will still be waiting next year. Against bcrypt, a dumb guessing machine is the wrong tool. You need to guess almost the right answer.

## 0x05 · one word in a hundred costumes

Now the note from the staff room pays off. The admin told you the passwords are all variations of `PleaseSubscribe!`. So you do not guess blindly. You start from that one word and let the cracker apply the small, human edits people actually make to passwords. Add a number on the end. Capitalize a letter. Swap an `s` for a `$`. Those edits live in a hashcat rule file, and `best64.rule` is the standard pocketknife of common mangles.

Picture a locksmith who already knows the key is some version of a single blank. They do not cut ten thousand random keys. They take that one blank and shave it a hair shorter, file one tooth down, add a notch, trying the small variations a sane person would make, until one slides in. That is rule-based cracking. One base word, plus a list of believable tweaks.

```
# echo 'PleaseSubscribe!' > base.txt
# hashcat -m 3200 hash.txt base.txt -r /usr/share/hashcat/rules/best64.rule
...
$2a$10$VM6EeymRxJ29r8Wjkr8Dtev0O.1STWb4.4ScG.anuu7v0EFJwgjjO:PleaseSubscribe!21
```

`-m 3200` tells hashcat the hash is bcrypt. The rule file does the imagining for you, and within seconds one variation matches. The password is `PleaseSubscribe!21`, the base word with two digits stapled on, exactly the kind of edit the staff message promised.

The hash you cracked belonged to the Mattermost `root` account, not the system root. But the whole point of the note was that these people reuse the same idea everywhere. So you try the cracked password on the actual machine.

```
maildeliverer@Delivery:~$ su -
Password: PleaseSubscribe!21
root@Delivery:~# id
uid=0(root) gid=0(root) groups=0(root)
root@Delivery:~# cat /root/root.txt
████████████████████████████████
```

The chat password idea, the database hash, and the system root login were all the same word in three different outfits.

## 0x06 · the honest caveat

It is easy to read Delivery as a string of silly mistakes and miss that none of the steps were bugs. osTicket handing out a mailbox is a feature. It is supposed to let people without accounts keep a conversation going. Mattermost trusting an email domain is a feature. It is the normal way a self-hosted server decides who is staff. Each piece, alone, is reasonable. The break happens where two reasonable systems meet and neither one is responsible for the other. The help desk never imagined its throwaway mailbox would be treated as proof of employment. The chat server never imagined the company domain could be rented for free at the front counter. Trust got passed between them like a hot coin, and nobody checked it.

That is the part worth carrying out of the lab. Most real breaches are not a genius cracking a wall. They are exactly this, a chain of small, sensible trust decisions that were never designed to be stacked. One service vouches for an identity it did not actually verify, and the next service believes the vouch.

And then there is the password, which is the oldest lesson wearing the thinnest disguise. The staff did not get rooted because their password was weak. `PleaseSubscribe!21` is long and mixed and would survive most attacks. They got rooted because they all used the same word, and because one of them said so in writing. A strong password reused across the chat app, the database thinking, and the root account is not three locks. It is one lock with three doors painted on it. The fix was never a longer password. It was a different password for every door, and a habit of never, ever describing the pattern out loud.

## 0x07 · outro

```
the counter gave a stranger a company mailbox.
the chat server saw the domain and called it staff.
the staff room held a note, and the note held a key.
the key fit the database, the database, and the throne.

nobody forced a thing. every door was held open
by a system politely trusting the one beside it.

verify the badge. vary the key. wear black.

                                                            EOF
```

---

*HTB: Delivery, retired 22 May 2021. An easy Linux box that is really a lecture on chained trust and password reuse, with not a single exploit fired. The free mailbox still opens in a lab and nowhere you don't own.*