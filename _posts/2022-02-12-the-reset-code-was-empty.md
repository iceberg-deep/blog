---
layout: post
title: "The Reset Code Was Empty"
subtitle: "HTB Horizontall, where a password reset that accepts nothing at all hands you a CMS, and a debug screen that should never have shipped hands you root"
date: 2022-02-12 12:00:00 +0000
description: "An empty reset code resets the admin's password, a plugin installer runs your shell, and a debug page left on in production poisons its own log into a root deserialization chain."
image: /assets/og/the-reset-code-was-empty.png
tags: [hackthebox, writeup]
---

Horizontall is a box about software that answers questions it was never asked. A password reset that takes an empty token and resets the admin anyway. A plugin installer that treats the plugin name as a command. A debug screen, the friendly one that paints a pretty stack trace when something breaks, left switched on in production where it will read its own log file back to itself as a live object. None of it is a memory-corruption trick. Every move is a piece of software being too helpful with input it should have refused, and the box just walks you down the line, one oversharing service handing you off to the next.

```
        H O R I Z O N T A L L
        =====================
        reset?   code: {}     "sure, here's a new admin password"
                    |
                    v
        install plugin: `your command`   "running it now"
                    |
                    v
        a second app hides on localhost, debug mode ON.
        it reads its own log out loud. so we write the log.
                    |
                    v
        the friendly error page detonates as root.
                                            錯
```

## 0x01 · the front desk

`nmap -sC -sV` against 10.10.11.105 comes back short. SSH, a web server, and one odd high port.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.6p1 Ubuntu
80/tcp   open  http    nginx 1.14.0 (Ubuntu)
1337/tcp open  http    Node.js (Express)
```

Port 80 redirects to `horizontall.htb`, so you add that to your hosts file and get a flat Vue.js marketing page. Vue builds everything client-side, which means the interesting part is not the HTML, it is the JavaScript the browser downloads to run the page. Pull the bundled `app.js`, read it like a map, and a second hostname falls out of the code: `api-prod.horizontall.htb`. The frontend is talking to a backend you were not shown. Add that name too, and now you have an API to knock on.

## 0x02 · the version on its sleeve

`api-prod.horizontall.htb` answers with a bare JSON `{"hello":"Welcome on Strapi"}`. Strapi is a headless CMS, a content backend with an admin panel bolted to the front. The admin lives at `/admin`, and the version it is running is the whole ballgame, so you ask it directly.

```
$ curl http://api-prod.horizontall.htb/admin/strapiVersion
{"strapiVersion":"3.0.0-beta.17.4"}
```

That string is a fossil. Strapi `3.0.0-beta.17.4` carries two public holes, and they chain perfectly. The first is CVE-2019-18818, a broken password reset. Think of it like a hotel that lets you reset the master keycard if you can read the confirmation number off the slip the printer spat out. On this version, the desk does not even check the number. Hand it a blank slip and it resets the card anyway.

```
$ curl -s -X POST http://api-prod.horizontall.htb/admin/auth/reset-password \
  -H 'Content-Type: application/json' \
  --data '{"code":{},"password":"icebergPass1","passwordConfirmation":"icebergPass1"}'
{"jwt":"eyJhbGci...","user":{"username":"admin", ...}}
```

The reset code is an empty object, `{}`, not a real token. The endpoint compares it the wrong way, decides the empty thing matches, and resets the admin password to whatever you sent. It hands back a JWT in the same breath. You are now logged in as the administrator of the CMS, and you never knew a single secret.

## 0x03 · the installer that runs words

The second hole is CVE-2019-19609, a command injection in the plugin installer. Strapi lets an admin install a plugin by name, and to do that it pastes the name straight into a shell command that calls the package manager. Picture a librarian who, when you request a book, reads the title out loud to an assistant in the back, and the assistant fetches whatever the title says to fetch. Request a book called `Dune; set the building on fire` and the assistant hears two perfectly good instructions.

Now that you hold the admin JWT, that endpoint is open to you. The vulnerable field is `plugin`, and anything you wrap in shell metacharacters runs on the server.

```
$ curl -s http://api-prod.horizontall.htb/admin/plugins/install \
  -H 'Authorization: Bearer eyJhbGci...' \
  -H 'Content-Type: application/json' \
  --data '{"plugin":"documentation && [ reverse shell over a named pipe back to 10.10.14.4 on 443 ]","port":"1337"}'
```

I am bracketing the reverse shell rather than printing it, and that habit is the lesson, not caution for its own sake. The payload is a couple of lines of `mkfifo` plumbing that pipes a shell back to a netcat listener, and the moment that exact text touches the wire it is a copy-paste backdoor. Describe the shape, build the real thing against your own catcher, never ship the literal string. Start your listener, fire the request, and the box drops a prompt.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.11.105
$ id
uid=1001(strapi) gid=1001(strapi) groups=1001(strapi)
$ cat /opt/strapi/.../user.txt
████████████████████████████████
```

You land as `strapi`, the low-privilege account the Node service runs as. Two oversharing endpoints, no exploit binary, and the user flag is yours.

## 0x04 · the app that only talks to itself

`strapi` cannot do much, so you look at what the box is running where it thinks nobody is watching. List the listening sockets.

```
$ netstat -tnlp
tcp  0  0 127.0.0.1:8000   0.0.0.0:*  LISTEN  -
tcp  0  0 127.0.0.1:3306   0.0.0.0:*  LISTEN  -
tcp  0  0 0.0.0.0:1337     0.0.0.0:*  LISTEN  -
```

There is a whole web server bound to `127.0.0.1:8000` that the outside world never sees. A service on localhost is a room with no exterior door. The only way in is to already be inside the house, which you now are. So you drill a tunnel. SSH port forwarding takes a port on the remote box and makes it appear on yours, like running a private phone line from their closet to your desk.

```
$ ssh -L 8000:localhost:8000 strapi@10.10.11.105
```

Now `http://localhost:8000` on your machine is their hidden app. The response headers say `X-Powered-By: PHP/7.4.18` and the error styling is unmistakable. This is Laravel, a PHP framework, and the homepage is a default install. A quick `gobuster` finds a `/profiles` route, and hitting it throws an exception. Crucially, the exception comes back as a full Laravel debug page, the lavish error screen with source snippets and stack frames. That screen is a development convenience. It is also a confession, because it means `APP_DEBUG=true` shipped to production.

## 0x05 · the page that reads its own diary

Laravel's debug screen is powered by a component called Ignition, and the version here carries CVE-2021-3129. The bug is gorgeous and grim. Ignition has a feature meant to auto-fix common errors, and to do it, it reads a file, runs it through PHP's `file_get_contents` and `file_put_contents`, and along the way it will deserialize whatever it reads. Deserialization is the act of turning saved text back into a live object. The danger is that some objects do work the instant they are rebuilt, so handing the function attacker-shaped text is the same as handing it instructions.

The catch is that you need to control the file it reads. So you make it read the log. Laravel writes errors to a log file, which means anything that triggers an error gets written there in your words. Picture a diary that records every visitor, and an assistant whose job is to read the diary aloud and act on whatever is written. You do not need to break into the diary. You walk in, say something quotable, and wait for the assistant to read your line back and obey it.

The full chain is two motions. First you craft a malicious serialized PHP object using `phpggc`, a tool that builds these gadget chains out of code that already lives in the app's libraries. The Monolog logging library has a known chain that ends in a system call.

```
$ phpggc --phar phar -o iceberg.phar --fast-destruct monolog/rce1 system 'id'
$ base64 -w0 iceberg.phar
```

Second, you drive the public exploit. It clears Laravel's log, writes your encoded payload into it by forcing a logged error, then calls the `_ignition/execute-solution` endpoint, which makes Ignition reopen the log and deserialize your gadget. The chain fires.

```
$ python3 laravel-ignition-rce.py http://localhost:8000 'id' iceberg.phar
[+] Logs cleared
[+] PHPGGC payload written to log
[+] Triggering deserialization...
uid=0(root) gid=0(root) groups=0(root)
```

`uid=0`. The Laravel process runs as root, so command execution as that process is command execution as root. Run the chain again to read the flag, or feed it a payload that drops your key into `/root/.ssh/authorized_keys` and SSH in clean.

```
$ cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Every gate on Horizontall was a feature with the safety filed off. A password reset is supposed to be a kindness for the locked-out admin. It became an open door because it compared the secret token the wrong way and an empty object slipped through, the same family of mistake as a login that returns true when it should return false. A plugin installer is supposed to fetch packages. It became a shell because it pasted user text into a command, the identical injection bug that has been working since the first program let a stranger's words reach the machinery. Hold the line between data and instructions and both of those holes close.

The one I would lose sleep over is the debug page. There is no exotic vulnerability in shipping `APP_DEBUG=true`. It is a single line in a config file, a switch someone flipped to see nicer errors while building and forgot to flip back before going live. That switch is the difference between a stack trace that helps a developer at 2am and a stack trace that hands a stranger your file paths, your framework version, and eventually a deserialization gadget that runs as root. You cannot patch your way out of a checkbox left on. Production is not a place you debug. It is a place you have already finished debugging, and the box is a quiet argument for knowing the difference.

## 0x07 · outro

```
the reset took an empty code and changed the admin anyway.
the installer took a plugin name and ran the part you hid inside it.
the debug page read its own log back as a living thing, and obeyed it.

three doors. none of them forced. each one was propped open by a default.

check the token. quote the input. turn off debug. wear black.

                                                            EOF
```

---

*HTB: Horizontall, retired 5 Feb 2022. An easy Linux box that is really a tour of software answering questions it was never asked, ending on a debug switch nobody turned off. The empty reset still works in a lab and nowhere you don't own.*