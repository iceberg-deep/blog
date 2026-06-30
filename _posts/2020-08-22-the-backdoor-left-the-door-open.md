---
layout: post
title: "The Backdoor Left the Door Open"
subtitle: "HTB Traceback, where another attacker's leftover webshell becomes your front door, a sudo Lua interpreter becomes a second user, and a login banner becomes root"
date: 2020-08-22 12:00:00 +0000
description: "Someone defaced Traceback and left their webshell behind. You walk in through it, ride a sudo Lua interpreter to a second user, then poison the login banner to become root."
image: /assets/og/the-backdoor-left-the-door-open.png
tags: [hackthebox, writeup]
---

Traceback is a box about a thief who left the window open behind them. Someone got here first, defaced the homepage, and bragged about it in plain text: a backdoor left for all the net. They meant it as a trophy. They did not realize they had just turned their own webshell into the front door for everyone who came after. So the first move on this box is not breaking in. It is guessing the name of a door that is already cut into the wall. From there a sudo rule hands you a Lua interpreter that runs as a second user, and that user happens to be able to edit the file that prints the login banner. Edit the banner, log in, and root runs your line for you.

```
        T R A C E B A C K
        =================
        homepage:  "i left a backdoor for all the net"
                   <!-- some of the best web shells ;) -->
                        |
                        v
        the thief's door is still cut into the wall.
        guess its name. walk through it.
                        |
        sudo luvit  →  lua runs as sysadmin
        motd script →  root prints your line at login
                                            戸
```

## 0x01 · the boast on the door

`nmap -sC -sV` is almost insultingly short. Two ports, both ordinary.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
80/tcp open  http    Apache httpd 2.4.29 ((Ubuntu))
```

Stock Ubuntu 18.04, current for its day, nothing rotting in a closet. The version numbers are a dead end on purpose. The box wants you on port 80, where the homepage greets you with a defacement: "This site has been owned" and a line bragging that the attacker left a backdoor "for all the net." The actual clue is in the page source, an HTML comment that reads `Some of the best web shells that you might need ;)`. That winking little note is the whole intro. The previous attacker did not just leave a door, they left a hint about where they shop for doors.

## 0x02 · guessing the name of someone else's door

Drop that exact comment string into a search engine and it leads to a public GitHub repository of PHP webshells, sixteen of them, with names like `alfa3.php`, `wso2.8.5.php`, and `smevk.php`. That list is not trivia. It is a wordlist. The previous attacker uploaded one of these to the server and never deleted it, so the file is sitting there right now answering to whoever knows its name. We just do not know which one yet.

Think of it like a burglar who jimmied a basement window and then spray-painted the brand of his crowbar on the wall. You do not need his crowbar. You need to try the sixteen windows that crowbar is known to open and see which one is still unlatched. So you turn the repo's filenames into a list and let `gobuster` knock on each one.

```
$ gobuster dir -u http://10.10.10.181/ -w webshells.txt -x php
===============================================================
/smevk.php            (Status: 200) [Size: 1261]
```

One answers. `smevk.php` is a known webshell with a login panel, and like a lot of these throwaway tools it ships with hardcoded default credentials baked right into its own source. A glance at the public copy of the file tells you the pair: `admin` / `admin`. The thief locked his backdoor with a padlock and left the combination printed on the box.

## 0x03 · borrowing the intruder's hands

Logged into the panel, smevk gives you a command box and a file manager. It runs everything as the web server's account, which on this box is a real user named `webadmin`. You do not need to live inside a clunky web panel, so use its command field once to call yourself back a proper shell, then drop the panel entirely.

```
# in the smevk command box, fire once:
[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
```

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.181]
$ id
uid=1000(webadmin) gid=1000(webadmin) groups=1000(webadmin)
```

I am describing the reverse shell in brackets rather than printing it, and that is deliberate. A live one-liner pasted onto disk is the exact pattern antivirus is built to quarantine, which is a funny kind of proof of how sharp the thing is. The shape is all you need: have the box dial your listener and hand you a prompt. Once you land as `webadmin`, write your own SSH key into that user's `authorized_keys` so you are not married to a fragile webshell session for the rest of the box.

## 0x04 · the interpreter that wears another face

`webadmin` is a low user, so the first question on any Linux box is always the same. What is this account allowed to do that it should not be? `sudo -l` answers it.

```
$ sudo -l
User webadmin may run the following commands on traceback:
    (sysadmin) NOPASSWD: /home/webadmin/luvit
```

This is the hinge of the box. `luvit` is an interpreter, a program that runs Lua scripts, the way Node runs JavaScript. And the sudo rule says `webadmin` may run it as the user `sysadmin`, no password asked. The trap here is thinking of `luvit` as a single safe tool. It is not a tool. It is a tool that runs whatever code you feed it, and the code runs as someone else.

Picture a hotel that lets you borrow a translator who only speaks for the manager. You are not allowed in the manager's office, but the translator is, and the translator says, word for word, whatever you tell him to say, in the manager's voice. So you do not ask to enter the office. You write a sentence for the translator to read aloud, and the sentence is an instruction. This is the whole idea behind the GTFOBins catalog: ordinary programs that, when handed to you through sudo, can be talked into running arbitrary commands as a more powerful user. Lua can open and write files, so the script is short. Have it append your SSH public key to `sysadmin`'s `authorized_keys`.

```
$ cat > /dev/shm/iceberg.lua << 'EOF'
local f = io.open("/home/sysadmin/.ssh/authorized_keys", "a")
f:write("ssh-ed25519 AAAA...your-public-key... iceberg\n")
f:close()
EOF

$ sudo -u sysadmin /home/webadmin/luvit /dev/shm/iceberg.lua
```

The translator read your line in the manager's voice, and now the manager's mailbox holds your key. SSH in as `sysadmin` and the user flag is waiting.

```
$ ssh -i iceberg_ed25519 sysadmin@10.10.10.181
sysadmin@traceback:~$ cat user.txt
████████████████████████████████
```

## 0x05 · poisoning the welcome mat

`sysadmin` is closer to the throne but still not on it. Watch the box for a beat and a pattern surfaces in the process list. Something is copying files into `/etc/update-motd.d/` on a tight loop, roughly every thirty seconds, restoring them from a hidden backup directory.

```
* * * * * /bin/cp /var/backups/.update-motd.d/* /etc/update-motd.d/
* * * * * sleep 30 ; /bin/cp /var/backups/.update-motd.d/* /etc/update-motd.d/
```

Two facts now collide. First, `update-motd.d` is the machinery behind the message of the day, the little banner Ubuntu prints when you log in. The scripts in that folder are not static text. They are run, and a man page is blunt about who runs them: `pam_motd` executes them as the root user at every login. Second, look at who owns them.

```
sysadmin@traceback:/etc/update-motd.d$ ls -l
-rwxrwxr-x 1 root sysadmin 981 00-header
-rwxrwxr-x 1 root sysadmin ... 10-help-text
```

Owned by `root`, but group `sysadmin`, and the group has write permission. You are in that group. So you can edit a script that root will run, for you, automatically, the next time anyone logs in.

Think of it like the doormat at the front entrance that the building owner personally reads aloud every time they walk in. You are not allowed to be the owner, but you are allowed to write on the mat. So you write an instruction on the mat, wait for the owner to come home, and they read your instruction out loud in their own authority. The catch is the thirty-second broom. That cron job sweeps the mat clean twice a minute, so you have a short window to write your line and then trigger a login before it gets wiped. Append a command to `00-header` that hands you root, then immediately open a new SSH session to fire it.

```
sysadmin@traceback:/etc/update-motd.d$ echo 'cp /home/sysadmin/.ssh/authorized_keys /root/.ssh/' >> 00-header

# in another window, log in before the 30s sweep:
$ ssh sysadmin@10.10.10.181
```

That fresh login makes `pam_motd` run `00-header` as root, which copies your already-trusted key into root's `authorized_keys`. Now SSH in one more time, as root, with the same key.

```
$ ssh -i iceberg_ed25519 root@10.10.10.181
root@traceback:~# id
uid=0(root) gid=0(root) groups=0(root)
root@traceback:~# cat root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Nothing on Traceback is a software vulnerability. There is no CVE to cite, no buffer to smash, no version number to look up. Every single step is a misplaced piece of trust, and that is exactly why the box is worth your evening.

The webshell is the loudest lesson and the easiest to wave away as fiction. It is not. When a real machine is compromised, attackers leave webshells behind constantly, and they are sloppy, and they protect them with default passwords printed in the tool's own source. The previous intruder's backdoor became our front door because nobody cleaned up after the breach. Patching the box would not have helped. Only noticing the extra file would have.

The Lua step is the one to carry to work. A sudo rule that looks like it grants one specific safe program almost never grants one specific safe program. If that program can run code, read a file, or spawn anything, then `NOPASSWD` on it is `NOPASSWD` on a shell as the target user. GTFOBins exists precisely to enumerate which everyday binaries quietly hand out that power, and the list is long. The fix is not to trust the binary's name. It is to assume any interpreter, pager, or editor handed to you through sudo is a shell wearing a costume.

And the banner is the quiet one I would lose sleep over. A file that root executes on every login, left group-writable to a non-root user, is a root shell with a delay timer. It ships green, no exploit required, just a permission bit set one notch too loose and a habit of trusting the welcome mat. You cannot patch your way out of that. You can only audit who is allowed to write the things root runs on your behalf.

## 0x07 · outro

```
the thief bragged about his backdoor and forgot to lock it behind him.
the interpreter spoke in a voice that was not its own.
the welcome mat carried an order, and root read it out loud.

three open doors, none of them forced. each was left ajar by someone trusted.

clean up the breach. distrust the binary. mind the mat. wear black.

                                                            EOF
```

---

*HTB: Traceback, retired 15 Aug 2020. An easy Linux box that is really a lecture on inherited trust, where the only exploit is noticing what other people left lying around. The leftover webshell still answers in a lab and nowhere you don't own.*