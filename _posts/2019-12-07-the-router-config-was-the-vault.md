---
layout: post
title: "The Router Config Was the Vault"
subtitle: "HTB Heist, where a support ticket leaks a Cisco config, two reversible password schemes hand you a foothold, and a browser left logged in spills the admin's key out of its own memory"
date: 2019-12-07 12:00:00 +0000
description: "A leaked Cisco config, two password schemes that were never really encryption, and a browser that kept the admin's password in plain memory."
image: /assets/og/the-router-config-was-the-vault.png
tags: [hackthebox, writeup]
---

Heist is a box about secrets that were never as locked as their owners believed. It opens on a help desk, and the first ticket on the board is an engineer complaining that his Cisco router is misbehaving. He pastes the config to prove it. That config is the whole heist, because two of the password formats Cisco ships are not encryption at all, just scrambling you can undo on a napkin. You unscramble them, spray the recovered words across the domain, and land as a low user. Then you notice the real prize. Someone left a browser open and logged in, and a logged-in browser keeps the password it sent sitting in plain memory. You dump the process, read the password off the floor, and it is the administrator's. Nobody picked a single lock. Every door on this box was already holding its key in its hand.

```
        H E I S T   S U P P O R T   D E S K
        ===================================
        ticket #1:  "my cisco router config is broken,
                     here's the whole thing ->"   [attachment]
                        |
                        v
        password 7 ...  (scrambled, not locked)  -> undo it
        secret    5 ...  (real hash)             -> crack it
                        |
                        v
        spray the words. one opens a winrm shell.
        on the desk, a browser still logged in,
        whispering the admin's password to its own RAM.
                                            金
```

## 0x01 · the help desk

`nmap` paints a short, very Windows picture. A web server, the RPC and SMB stack, WinRM up on 5985, and one high RPC port hanging out.

```
PORT      STATE SERVICE       VERSION
80/tcp    open  http          Microsoft IIS httpd 10.0
135/tcp   open  msrpc         Microsoft Windows RPC
445/tcp   open  microsoft-ds
5985/tcp  open  http          Microsoft HTTPAPI httpd 2.0 (WinRM)
49669/tcp open  msrpc         Microsoft Windows RPC
```

Two of those ports are a promise. WinRM on 5985 is remote PowerShell, which means if I ever find a username and password that belong together, I get a real shell with no exploit at all. And RPC sitting open is the Windows habit of answering questions about itself to anyone who can authenticate. Hold both thoughts. The box is built so that one valid credential turns every other service into a helpful clerk.

The site on 80 is a support portal with a `login.php`. There is a "login as guest" link, and guests can read the ticket queue.

## 0x02 · the ticket nobody should have posted

The queue has one conversation that matters. A user named Hazard is venting that his Cisco router config will not load right, and to make his case he attaches the entire running config. Picture a tenant emailing the building super to complain the lock is jammed, and stapling a photo of his whole keyring to the message so the super can see the problem. The intent is helpful. The result is that everyone reading the thread now holds the keys.

Inside the config are three credentials, and they are stored three different ways.

```
enable secret 5 $1$pdQG$o8nrSzsGXeaduXrjlvKc91
username rout3r password 7 0242114B0E143F015F5D1E161713
username admin privilege 15 password 7 02375012182C1A1D751618034F36415408
```

The numbers after `password` and `secret` are the format tags, and they are the entire lesson of this box. Type 7 is not encryption. Type 5 is a real hash. Treating those two as the same kind of secret is the mistake that costs the box its front door.

## 0x03 · two scrambles and a real lock

The two `password 7` strings look encrypted, but Cisco type 7 is just a fixed shuffle. The first two digits say where to start in a hardcoded key string, and from there every byte is XORed against that same constant, `tfd;kfoA,.iyewrkldJKD`, the same key on every Cisco device on Earth. Think of it like a kid's decoder ring where the ring is printed in the manual. There is no secret to steal, because the method was never secret. Anyone with the published key reverses it in a heartbeat.

A short decoder does it. The math is so small it fits in a few lines of Python.

```
$ ./cisco7.py 0242114B0E143F015F5D1E161713
$uperP@ssword
$ ./cisco7.py 02375012182C1A1D751618034F36415408
Q4)sJu\Y8qz*A3?d
```

The `enable secret 5` value is the honest one. Type 5 is salted MD5 crypt, an actual one-way hash, so there is nothing to reverse. You have to guess and check. Throw it at `john` with a wordlist and let it grind.

```
$ john --wordlist=/usr/share/wordlists/rockyou.txt secret5.hash
stealth1agent   (?)
```

Three words fall out: `stealth1agent`, `$uperP@ssword`, and `Q4)sJu\Y8qz*A3?d`. Two were merely scrambled. One was genuinely locked and happened to be a phrase in everyone's wordlist. I keep all three and the one obvious username, Hazard, and head for the doors that ask for a login.

## 0x04 · one credential, and the box starts talking

Spray the three passwords against the host with `crackmapexec` over SMB and watch for a hit.

```
$ crackmapexec smb 10.10.10.149 -u hazard -p passwords.txt
SMB  10.10.10.149  445  SUPPORTDESK  [+] SUPPORTDESK\hazard:stealth1agent
```

`hazard:stealth1agent` is real. It does not get me a shell yet, because Hazard is not in the remote-management group, but it does something quieter and just as useful. It lets me ask the box who else lives here.

This is where that open RPC port pays out. With one valid credential, `lookupsid.py` walks the relative IDs and reads back the full roster of accounts. Picture a doorman who will not let you upstairs but, once he knows your name, happily reads the entire tenant directory off the wall.

```
$ lookupsid.py SUPPORTDESK/hazard:stealth1agent@10.10.10.149
500: SUPPORTDESK\Administrator (User)
1008: SUPPORTDESK\Hazard (User)
1009: SUPPORTDESK\support (User)
1012: SUPPORTDESK\Chase (User)
1013: SUPPORTDESK\Jason (User)
```

New names, same old passwords. Now it is a matching game: four users, three words, find the pair that opens WinRM. Loop the usernames against the password list, watching for a session that actually establishes, and one combination clicks.

```
SUPPORTDESK\chase : Q4)sJu\Y8qz*A3?d   -> WinRM accepts
```

Chase reused the router's `admin` password as his own. The scrambled type 7 string from a help-desk attachment is now a domain login.

## 0x05 · the shell on the desk

Chase is in the remote-management group, so `evil-winrm` hands over a clean PowerShell session and the first flag.

```
$ evil-winrm -i 10.10.10.149 -u chase -p 'Q4)sJu\Y8qz*A3?d'
*Evil-WinRM* PS C:\Users\Chase\Documents> type ..\Desktop\user.txt
████████████████████████████████
```

Chase is not an administrator, so the climb continues. Before reaching for an exploit, I read the room. What is this user actually doing on the box right now.

```
*Evil-WinRM* PS C:\> Get-Process firefox

Handles  NPM(K)    PM(K)      WS(K)   Id  ProcessName
-------  ------    -----      -----   --  -----------
    ...                            6252  firefox
```

Five Firefox processes, running as Chase. A browser is open. And a browser that is open on a login portal is a browser that recently typed a password into a form and still has it lying around.

## 0x06 · the browser that kept the receipt

Here is the quiet vulnerability, and there is no CVE attached to it. When you submit a login form, the browser packs your username and password into the request body and sends it. Sending it does not erase it. The bytes linger in the process memory until something overwrites them, and most of the time nothing does for a long while. Think of it like a cashier who rings up your card, hands back the receipt, and then leaves a carbon copy of the full number face-up in the open drawer. The transaction finished. The number is still sitting there for anyone who opens the till.

So I open the till. The clean way is Sysinternals `procdump`, which freezes a process and writes its entire memory to a file. Upload it through the WinRM session, dump the Firefox PID, and pull the file back.

```
*Evil-WinRM* PS C:\Users\Chase\Documents> upload /tools/procdump64.exe
*Evil-WinRM* PS C:\Users\Chase\Documents> .\procdump64.exe -accepteula -ma 6252 iceberg.dmp
[12:04:31] Dump 1 complete: 281 MB written
*Evil-WinRM* PS C:\Users\Chase\Documents> download iceberg.dmp
```

Now it is a 281 MB haystack with a very specific needle. The login form posts a body shaped like `login_username=...&login_password=...`, so I grep the dump for exactly that envelope.

```
$ grep -aoE 'login_username=.{1,30}@.{1,30}&login_password=.{1,40}&login=' iceberg.dmp
login_username=admin@support.htb&login_password=4dD!5}x/re8]FBuZ&login=
```

There it is, in the clear, where the browser left it. `4dD!5}x/re8]FBuZ`. That is the password the site's own `login.php` checks against, and on this box the person who manages the site is the person who manages the machine. Same password, administrator account.

```
$ evil-winrm -i 10.10.10.149 -u administrator -p '4dD!5}x/re8]FBuZ'
*Evil-WinRM* PS C:\Users\Administrator> whoami
supportdesk\administrator
*Evil-WinRM* PS C:\Users\Administrator> type Desktop\root.txt
████████████████████████████████
```

No privilege-escalation exploit. The admin's password walked out of a process its own user left running.

## 0x07 · the honest caveat

Heist never gets broken into. Every step is a secret behaving exactly as designed, just stored or handled by someone who misread what "stored" meant. The Cisco type 7 password is the cleanest example. It looks encrypted, it has hex and everything, but it was only ever obfuscation, and Cisco has said so for decades. People keep treating reversible scrambling as if it were a lock, and the gap between those two ideas is where this box lives. If a secret can be turned back into plaintext with a published key and no password of your own, it is not protected. It is in a costume.

The browser dump is the part that should keep an engineer up at night, because nothing was misconfigured and nothing was unpatched. A process holding a recently submitted password in its memory is just how memory works. You cannot patch that away. The defense is upstream and human: do not store credentials in formats that were never encryption, do not reuse the router password as your domain password, and do not leave a privileged browser logged in on a shared box. The credential reuse is the hinge the whole heist swings on. One word, `Q4)sJu\Y8qz*A3?d`, was a router login, then Chase's login, and that single act of laziness is what connected the help-desk ticket to a shell. The leak loaded the gun. Reuse aimed it.

## 0x08 · outro

```
the engineer pasted his whole config to ask for help.
two of the passwords were never locked, only folded.
one folded word fit a second door, then a third.

and on the desk a browser sat there logged in,
holding the admin's password in its open hand.

undo the scramble. spray the reuse. read the memory. wear black.

                                                            EOF
```

---

*HTB: Heist, retired 30 Nov 2019. An easy Windows box that is really a lecture on what "encrypted" does and does not mean, plus the oldest sin in shared computing: a logged-in session left running. The config still leaks in a lab and nowhere you don't own.*