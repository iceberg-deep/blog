---
layout: post
title: "A Secret Read Aloud Down a Hallway"
subtitle: "HTB Search, where a password printed on a photo opens a directory that keeps confessing, one careless drawer at a time, until a service account reads itself the keys to the kingdom"
date: 2022-05-07 12:00:00 +0000
description: "A password hidden in a website photo starts a long walk through Active Directory, where every account you reach is holding the key to the next one."
image: /assets/og/a-secret-read-aloud-down-a-hallway.png
tags: [hackthebox, writeup]
---

Search is a directory that cannot stop talking. There is no buffer overflow here, no memory-corruption magic trick, no single clever exploit you can point to and call the box. There is a corporate website with a password written on one of its photos, and once you whisper that password back to Active Directory, the directory starts telling you everything. It tells you who the users are. It tells you which account left its name lying in a place it shouldn't. Each person you reach is holding a key to the next person, and the next person is holding a key to the one after that, until you arrive at a service account that Windows itself manages, and that account, when you ask it nicely, reads you its own password and then hands you the entire domain. The whole box is a hallway of unlocked drawers, and the only skill it really tests is your willingness to keep opening them.

```
        S E A R C H   ( . htb )
        =======================
        photo on the homepage:
          "send password to Hope Sharp"   IsolationIsKey?
                        |
                        v
        ldap opens.  every user, every group, spilled.
          web_svc  ->  kerberoast  ->  cracked
          reused on  Edgar.Jacobs  ->  a locked spreadsheet
          hidden column  ->  Sierra.Frye  ->  a .pfx in Downloads
                        |
                        v
        a service account reads its OWN password aloud,
        and that account can rewrite the king.
                                            鍵
```

## 0x01 · the lobby

`nmap` comes back loud and unmistakably a domain controller. DNS, web on 80 and 443, Kerberos on 88, the SMB stack, LDAP on 389 and 636, the global catalog up on 3268, and the Active Directory web services port at 9389. This is not a single application wearing a server. This is the brain of a Windows network with the lights on.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
80/tcp   open  http          Microsoft IIS httpd 10.0
88/tcp   open  kerberos-sec
389/tcp  open  ldap          Microsoft Windows AD LDAP
443/tcp  open  ssl/http      Microsoft IIS httpd 10.0
445/tcp  open  microsoft-ds
636/tcp  open  ssl/ldap
3268/tcp open  ldap
9389/tcp open  adws
8172/tcp open  ssl/http      Microsoft IIS httpd 10.0
```

The website is a slick consulting front, the kind with stock photos of people pointing at whiteboards. One of those photos is the whole foothold. Zoom into a laptop screen in the image and there is a chat window, and in the chat window someone has typed a note to a coworker: send the password to Hope Sharp, and the password is `IsolationIsKey?`. Nobody encrypted it. Nobody redacted it. It is sitting in a marketing photo on the public internet, written down the way people write things down when they trust a picture more than they should.

## 0x02 · the password on the photo

A username and a password are only a rumor until something agrees with them. `crackmapexec` is the cheapest way to ask the domain whether this rumor is true.

```
$ crackmapexec smb 10.10.11.129 -u hope.sharp -p 'IsolationIsKey?'
SMB  search.htb  [+] search.htb\hope.sharp:IsolationIsKey?
```

That little green plus is the entire box opening its front door. `hope.sharp` is nobody special, a low-privilege domain user with no obvious power. But in Active Directory, being a valid user at all is enormous, because a valid user can read the directory. Think of it like a corporate phone book that is locked in a glass case in the lobby. You cannot read it from the street, but the moment you are an employee, any employee, the case is open and you can copy down every name, every department, every group on the org chart. Hope is not important. Hope is a library card.

So we read the library. `ldapdomaindump` pulls the entire directory into tidy files, and `ldapsearch` lets us pick through it by hand.

```
$ ldapdomaindump -u 'search.htb\hope.sharp' -p 'IsolationIsKey?' 10.10.11.129 -o ldap/
[+] Domain dumped: 106 users, 63 groups, 113 computers
```

Buried in the dump are the tells that matter. One account, `Tristan.Davies`, sits alone in Domain Admins, the king of the hill. Another, `web_svc`, carries a description calling it a temporary helpdesk service account, which is the AD equivalent of a sticky note reading "do not forget to delete this." Service accounts are where the bodies are buried.

## 0x03 · roasting a service account

`web_svc` has a service principal name attached to it, and that single fact makes it Kerberoastable. Here is the bug class in plain terms. Kerberos hands out tickets to let users talk to services, and part of each ticket is encrypted with the service account's password. Any authenticated user is allowed to request one of those tickets, for any service, and take it home to crack offline.

Picture a coat check where, if you ask, the attendant hands you a locked box that was locked using the owner's house key as the combination. You are not supposed to be able to open it, but nothing stops you from carrying it home and trying every key on your ring until one fits. If the owner picked a weak combination, the box pops open and now you have their house key. That is Kerberoasting. The "locked box" is the ticket, and the weak combination is a human-chosen password.

```
$ GetUserSPNs.py -request -dc-ip 10.10.11.129 search.htb/hope.sharp -outputfile web_svc.hash
$ hashcat -m 13100 web_svc.hash rockyou.txt
$krb5tgs$23$*web_svc*...   :@3ONEmillionbaby
```

`web_svc` was guarding itself with `@3ONEmillionbaby`, a password just inside the wordlist's reach. The box gives you a service account by exploiting the one thing the protocol cannot fix, which is that a person chose the password.

## 0x04 · the key that fit two locks

Here is where Search reveals its real personality. `web_svc` does not directly unlock anything new, but its password is a piece of evidence, and evidence in this box wants to be reused. We take every username from the LDAP dump, pair it against the passwords we have collected, and spray the whole list at the domain, watching for a second door that opens with the same key.

```
$ crackmapexec smb 10.10.11.129 -u users.txt -p passwords.txt --continue-on-success
SMB  search.htb  [+] search.htb\web_svc:@3ONEmillionbaby
SMB  search.htb  [+] search.htb\Edgar.Jacobs:@3ONEmillionbaby
```

`Edgar.Jacobs`, a real human user, was using the exact password assigned to the helpdesk service account. Same PIN on the phone and the bank card. Edgar can read files that web_svc could not, and on his desktop, shared out over SMB, sits a spreadsheet named for a phishing exercise.

The spreadsheet is locked, but it is locked the way an office door is locked with a doorstop. An Office file is secretly a zip archive, so you unzip it, find the worksheet's XML, and delete the one tag that says "this sheet is protected." Think of it like a diary with a tiny brass clasp. The clasp says private, but the cover is unscrewed and you can simply lift the whole back panel off. Underneath the protection is a hidden column, and the hidden column is a list of fourteen employees with their passwords typed in plaintext, the trophy from a phishing test that became a trophy for us instead.

```
$ crackmapexec smb 10.10.11.129 -u xlsx_users.txt -p xlsx_passwords.txt --no-bruteforce
SMB  search.htb  [+] search.htb\Sierra.Frye:$$49=wide=STRAIGHT=jordan=28$$18
```

One of those fourteen, `Sierra.Frye`, has the access we need for the next hop.

## 0x05 · the certificate in the drawer

Sierra's home folder, reached over SMB, has a `Downloads\Backups` directory holding two certificate files, `staff.pfx` and a CA bundle. A `.pfx` is a sealed envelope containing a private key and the certificate that proves it is yours, and like everything else on this box, the envelope is sealed with a weak password we can crack.

```
$ pfx2john staff.pfx > staff.hash
$ john -w=rockyou.txt staff.hash
misspissy        (staff.pfx)
```

Why does a backed-up certificate matter? Because Search runs PowerShell Web Access, a feature that puts a full PowerShell console behind a web page at `https://search.htb/staff`, and that page is gated by mutual TLS. Normal HTTPS only asks the server to prove who it is. Mutual TLS turns it around and demands that the client prove who it is too, by presenting a certificate the server trusts. Picture a members-only club where showing up is not enough. The door has a slot, and you must slide your own engraved membership card into it before the bouncer will even speak to you. The `.pfx` is that engraved card. Import it into the browser with the password `misspissy`, walk up to `/staff`, present the card, and then log in with Sierra's credentials to land inside a PowerShell prompt on the box.

```
$ ls Downloads/Backups/
staff.pfx   search-RESEARCH-CA.p12
[ import staff.pfx into Firefox -> visit https://search.htb/staff -> PSWA console as Sierra.Frye ]
PS search\sierra.frye> whoami
search\sierra.frye
```

`user.txt` is on Sierra's desktop.

```
PS> type C:\Users\Sierra.Frye\Desktop\user.txt
████████████████████████████████
```

## 0x06 · the account that reads itself

Now we point BloodHound at the domain to see what Sierra is secretly capable of, because the chain to Domain Admin is never advertised, it is only implied by a web of group memberships nobody on the blue team ever fully draws out.

```
$ bloodhound-python -u hope.sharp -p 'IsolationIsKey?' -d search.htb -c All -ns 10.10.11.129
```

The path it finds is the elegant heart of the box. Sierra belongs to a group, that group belongs to another group, and that outer group, `ITSEC`, holds a permission called ReadGMSAPassword over a service account named `BIR-ADFS-GMSA`. And that service account, in turn, has full control over `Tristan.Davies`, the lone Domain Admin.

```
Sierra.Frye  ∈  BIRMINGHAM-ITSEC  ∈  ITSEC
       │
       │  ReadGMSAPassword
       ▼
  BIR-ADFS-GMSA$  ──GenericAll──►  Tristan.Davies  ∈  Domain Admins
```

A group Managed Service Account is Active Directory's answer to the password-rotation problem. Instead of a human picking a password and forgetting to change it, Windows generates a long random one and rotates it automatically, storing it in the directory itself. The catch is the access control on that stored password. Whoever holds ReadGMSAPassword is allowed to read the current value, in the clear, at any time. Think of it like a hotel safe that changes its own combination every few weeks so no guest can memorize it, except the safe is wired to read the current combination aloud to anyone on a short approved list. Sierra, through two layers of group membership, is on that list. So from her PowerShell console we simply ask the account for its own password, and it tells us.

```
PS> $gmsa = Get-ADServiceAccount -Identity 'BIR-ADFS-GMSA' -Properties 'msDS-ManagedPassword'
PS> $blob = ConvertFrom-ADManagedPasswordBlob $gmsa.'msDS-ManagedPassword'
PS> $sec  = $blob.SecureCurrentPassword
```

## 0x07 · rewriting the king

`BIR-ADFS-GMSA` has GenericAll over Tristan, the Domain Admin, and GenericAll means total control. We do not need to know Tristan's password. We become the service account, and as the service account we simply overwrite Tristan's password with one of our own choosing.

```
PS> $cred = New-Object System.Management.Automation.PSCredential('search\BIR-ADFS-GMSA', $sec)
PS> Invoke-Command -ComputerName 127.0.0.1 -Credential $cred -ScriptBlock {
        Set-ADAccountPassword -Identity tristan.davies -Reset `
          -NewPassword (ConvertTo-SecureString -AsPlainText 'icebergP4ss!!!' -Force) }
```

The king's locks are now keyed to us. Authenticate as the Domain Admin and the box is over.

```
$ wmiexec.py 'search/tristan.davies:icebergP4ss!!!@10.10.11.129'
search\tristan.davies
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x08 · the honest caveat

Not one step in Search was an exploit in the sense people mean when they picture hacking. There was no overflow, no shellcode, no CVE to patch your way out of. Every single hop was a piece of trust that someone configured exactly as intended, and the box just walked the trust to its logical end. The password in the photo was a real password used the way it was meant to be used, only photographed. The Kerberoast abused a feature that works as designed. The reused password, the plaintext column in the phishing spreadsheet, the certificate left in a Downloads folder, the group nesting that quietly granted ReadGMSAPassword, none of it was a vulnerability you could scan for. It was a hundred small decisions that each looked reasonable in isolation and added up to a hallway of open drawers.

That is the thing about Active Directory, and the reason these boxes feel less like breaking and more like reading. The dangerous flaws are almost never in the code. They are in the relationships between accounts, the permissions that accreted over years, the service account someone created on a Tuesday and a group somebody nested inside another group to save a ticket. You cannot `apt upgrade` your way out of GenericAll. The whole second half of this box, from BloodHound to the gMSA to the password reset, was a chain that shipped green and fully patched and was still a straight line to Domain Admin. Paranoia about your own permission graph is the only patch, and almost nobody runs it.

## 0x09 · outro

```
the photo confessed a password.
the directory confessed everyone.
each account held the key to the next,
        and the last one read itself aloud.

no exploit fired. nothing was unpatched.
a hundred reasonable choices made one long hallway,
and every door was held open from the inside.

map the trust. mind the drawers. wear black.

                                                            EOF
```

---

*HTB: Search, retired 30 Apr 2022. A hard Windows box that is really a lecture on Active Directory trust, where the only exploit is human habit and a service account that hands you the kingdom by reading its own password.*