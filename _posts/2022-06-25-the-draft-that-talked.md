---
layout: post
title: "The Draft That Talked"
subtitle: "HTB Paper, where an unpublished blog post leaks a secret door, a helpful chatbot reads the wrong file, and a seven-second race makes you root"
date: 2022-06-25 12:00:00 +0000
description: "A WordPress draft nobody published spills a private chat URL, a customer-service bot traverses out of its own folder, and a race against polkit hands over root."
image: /assets/og/the-draft-that-talked.png
tags: [hackthebox, writeup]
---

Paper is a box about things that were never supposed to be read out loud. A blog draft, half-finished and unpublished, sitting in a database where the author assumed nobody could see it. A chatbot built to fetch files for the office, doing exactly that with no sense of where the office ends. A private password parked in a config file because config files feel like a back room nobody visits. None of it is a memory-corruption trick. The whole machine is one long lesson in the gap between "hidden" and "secured," and every step is somebody confusing the two. You read the words they meant to keep private, you follow the address those words give you, and you walk in.

```
        P A P E R   C O.
        ================
        /?static=1   "show me everything, drafts and all"
                     wordpress reads its own scratch notes
                     aloud, including the one that says:
                     "psst, the private chat is over here"
                        |
                        v
        a bot named recyclops fetches any file you name.
        you name one outside its room. it fetches that too.
                        |
                        v
        a config file coughs up a password.
        then root is just a stopwatch.
                                            紙
```

## 0x01 · the lobby

Three ports, nothing loud. SSH, and a web server answering on both 80 and 443.

```
PORT    STATE SERVICE  VERSION
22/tcp  open  ssh      OpenSSH 8.0 (CentOS)
80/tcp  open  http     Apache httpd 2.4.37
443/tcp open  ssl/http Apache httpd 2.4.37
```

The HTTP response carries a tell most people scroll right past. Apache hands back a default CentOS test page, but tucked in the headers is `X-Backend-Server: office.paper`. The server is quietly naming a coworker. Picture a receptionist who answers "this isn't the right desk" and then, unprompted, mutters the name of the department you actually wanted. Add `office.paper` to your hosts file, point your browser at it, and the real site loves out of hiding. A WordPress blog, themed off characters from The Office, with a few posts and a comment thread where one employee scolds another about leaving secrets lying around. That comment is the entire box telling you what it is, and most of us read right over it the first time.

## 0x02 · the draft nobody published

The site runs WordPress 5.2.3, which you can read straight off the RSS generator tag. That version sits inside the window for CVE-2019-17671, and the bug is almost too simple to call an exploit.

Here is the whole thing. WordPress lets a post be a draft, private, unpublished, a scratch note only the author should see. The access check that enforces that privacy lived in the normal page-rendering path. But there was a second path, an older query mode triggered by a `static` parameter, that pulled posts from the database and never asked whether you were allowed to see them. Think of it like a diary with a lock on the front cover, where the back cover was never sewn shut. The lock works perfectly. You just flip the book over.

```
http://office.paper/?static=1
```

The page returns the published posts and the drafts, side by side, with no idea it has just emptied the author's desk drawer onto the table. Among the unfinished scribbles is one written to a coworker, and it reads like a confession.

```
# Secret Registration URL of new Employee chat system
http://chat.office.paper/register/8qozr226AhkCHZdyU

# I am keeping this draft unpublished, as unpublished
# drafts cannot be accessed by outsiders... right?
```

That last line is the joke and the lesson in one breath. The draft was never published. It was also never private. A registration link for an internal chat server, handed to you by the one document that was sure it was safe.

## 0x03 · a room you let yourself into

Follow the address. `chat.office.paper` is a Rocket.Chat instance, and the leaked link drops you straight onto its self-service registration form. Make an account, any account, and you are inside the company's private chat as a new "employee." Nobody approved you. The secret URL was the only gate, and the gate was sitting in a file you were never supposed to open.

Inside, the channels show a bot called `recyclops`, a little helper the staff built so people can ask it to fetch files, list directories, run small office errands. It is friendly. It is also the next door. Direct-message it and it tells you exactly how to drive it.

```
recyclops help
> file <filename>   - reads a file out of the sales directory
> list <dir>        - lists a directory
```

It reads files out of a sales folder. Helpful. The problem is the word "out of."

## 0x04 · the bot that wandered off

The bot takes a filename and reads it back to you. It assumes the filename you give it stays politely inside its assigned folder. It does not check. So you hand it a filename that climbs out.

```
recyclops file ../../../../etc/passwd
> root:x:0:0:root:/root:/bin/bash
> dwight:x:1004:1004::/home/dwight:/bin/bash
> ...
```

That `../` is the entire trick, repeated until you reach the root of the filesystem and then walking back down to whatever you want. Picture a mailroom clerk told to fetch any folder from filing cabinet B. You write "the folder three cabinets to the left of B, in the manager's locked office" on your request slip, and the clerk, who only ever checks that you wrote *a* folder name, walks right past cabinet B and fetches it. The clerk is doing its job. Nobody told it the manager's office was off limits, because everyone assumed the request slip would only ever name cabinet B.

The bot is a Hubot, and Hubots keep their secrets in a `.env` file one directory up from where the bot's brain lives. So you climb to it.

```
recyclops file ../hubot/.env
> export ROCKETCHAT_USER=recyclops
> export ROCKETCHAT_PASSWORD=Queenofblad3s!23
```

There it is. A password in plaintext, sitting in an environment file because environment files feel like a back room. It belongs to the bot's chat account, but `dwight` showed up in that `/etc/passwd` a moment ago, and people reuse passwords the way they reuse the same four-digit PIN for everything. The chat password is also Dwight's login.

```
$ ssh dwight@10.10.11.143
dwight@10.10.11.143's password: Queenofblad3s!23
[dwight@paper ~]$ cat user.txt
████████████████████████████████
```

## 0x05 · the seven-second window

Dwight is an ordinary user on a CentOS box, and CentOS in this era ships a version of polkit carrying CVE-2021-3560, found by Kevin Backhouse. This one is beautiful and a little absurd, and it is worth slowing down for because the bug is a timing accident, not a corrupted byte.

Polkit is the doorman that decides whether a normal user is allowed to do an administrator-only thing, like creating a new account. When a request comes in over the D-Bus message system, polkit pauses and asks the bus daemon a simple question. Who actually sent this. It uses the answer to decide yes or no. The flaw is in what happens if the sender vanishes mid-conversation. If you fire off the request to create a privileged user and then kill your own process at exactly the right instant, polkit asks "who sent this" about a process that no longer exists, fumbles the error, and fills in the blank with user ID zero. Root. It now believes root personally asked for the new admin account, so it cheerfully obliges.

Think of it like asking a bouncer to let your friend in, then ducking out of sight the half-second before he turns to check your wristband. He spins around, sees nobody where the request came from, and rather than say no he assumes the request must have come from the owner of the club. So he waves your friend straight past the rope.

The catch is the timing. You have to kill the request inside the tiny window after polkit receives it and before it finishes checking. Too early or too late and nothing happens, so the exploit just loops, firing the request and racing the clock until one attempt lands in the gap. Public proof-of-concept scripts wrap the whole race in a loop and run it for you.

```
[dwight@paper ~]$ ./iceberg-polkit.sh
[*] spraying account-creation requests and racing the auth check...
[*] try 1 ... missed the window
[*] try 4 ... missed the window
[*] try 6 ... hit. created user 'iceberg' (uid 0 group, sudo)
[*] log in as iceberg, password: iceberg

[dwight@paper ~]$ su iceberg
Password: iceberg
[iceberg@paper dwight]$ sudo bash
[root@paper ~]# id
uid=0(root) gid=0(root) groups=0(root)
[root@paper ~]# cat /root/root.txt
████████████████████████████████
```

A few seconds of losing a coin-flip, then one win, and the doorman invents permission out of an error it did not know how to handle.

## 0x06 · the honest caveat

The thread running through every floor of this box is the same quiet wrong assumption, that something which is hard to find is therefore safe. The draft was unpublished, so surely no outsider could read it. The chat link was a long random string, so surely only invited staff had it. The password lived in a hidden config file, so surely that counted as locked away. Every one of those was an author confusing obscurity with a wall, and an attacker who simply declined to play along.

That is the lesson worth taping to the monitor. Hidden is not the same as protected. A secret URL is a password you accidentally printed on the door. A draft post is private only until something forgets to check, and on a long enough timeline something always forgets to check. The path traversal in the bot is the same disease wearing a different coat, a program that trusted its input to stay inside the lines because the happy path always did. And the polkit race is the scariest of the lot, because nobody fat-fingered a permission. The code was logically wrong about what an error means, and you cannot grep your config files for that. The fix is a patch and a habit of never deciding "they'll never find it" is a security control. They find it. They are reading your drafts right now.

## 0x07 · outro

```
the draft was sure no one was reading it.
the bot was sure the filename was a filename.
the doorman was sure the silence meant the boss.

three certainties, three open doors.
none of them were locked. all of them felt like they were.

publish nothing you wouldn't post. fence the bot. mind the stopwatch. wear black.

                                                            EOF
```

---

*HTB: Paper, retired 18 Jun 2022. An easy Linux box that is really a lecture on the difference between hidden and secured, wearing a WordPress draft, a chatbot, and a polkit race for a costume.*