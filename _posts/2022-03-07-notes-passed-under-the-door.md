---
layout: post
title: "Notes Passed Under the Door"
subtitle: "HTB Object, where a firewalled Jenkins runs your commands but can never call home, so you make it leave the answers in a file, decrypt its secrets, then walk a chain of who-can-reset-whom to the top"
date: 2022-03-07 12:00:00 +0000
description: "Object is a build server in a locked room. It will run anything you ask, but a firewall means it can never speak back, so you have it write the answers on slips of paper and read them through the window. Then you decrypt its stored secrets and walk an Active Directory permission chain to Domain Admin."
image: /assets/og/notes-passed-under-the-door.png
tags: [hackthebox, active-directory, jenkins, writeup]
---

Object is a box about working with a prisoner. There is a Jenkins build server that will run any command you hand it, which sounds like instant victory, except the room it sits in has no phone line out. The firewall blocks every outbound connection, so the usual move of having the server call you back with a shell simply dies in silence. You have to change how you think. Instead of asking the server to phone home, you make it write its answers on slips of paper and slide them under the door, where you can walk around and read them. Once you accept that, Object becomes a patient game of passing notes, decrypting a safe whose key was left in the same drawer, and following a chain of people who each have permission to reset the next one's password, all the way up to the top.

```
        O B J E C T
        ===========
        jenkins  →  runs your command, but firewall = no call home
              |       so write the answer to a file,
              v       read it back through the workspace window
        master.key + hudson.util.Secret + credentials.xml
              |       (the safe AND its key, same drawer)
              v
        oliver → can reset smith → who owns maria → who reaches root
        a relay of borrowed keys, mapped by bloodhound.
                                            物
```

## 0x01 · a build server behind glass

The scan shows a web server on 8080 running Jenkins, plus the usual domain-controller ports muffled behind a strict firewall. Jenkins is a build-automation tool, the kind of thing that compiles and tests code on a schedule, and it runs those builds as a privileged service. Get it to run a build of your choosing and you are running commands on the host.

The catch announces itself the moment you try anything. The Jenkins Script Console, the usual one-step path to code execution, is disabled. And every reverse shell you fire returns nothing. That is the firewall, dropping all outbound traffic. Picture a teller behind thick glass with no slot for a phone. They can hear your request and act on it, but they physically cannot call you back. So you stop trying to make them call.

## 0x02 · sliding the answer under the door

The way through is a normal Jenkins feature used sideways. You create a Freestyle project, the simplest kind of job, and give it a single build step, a Windows batch command. When the job runs, that command runs on the server. You cannot see the output over the network directly, but Jenkins keeps every job's files in a workspace, and that workspace is readable back through the web interface. So you redirect your command's output into a file, let the job finish, and then browse to that file.

```
# build step (batch): run a command, write its answer to a workspace file
whoami > out.txt 2>&1
# then read it through the front end:
http://10.10.11.132:8080/job/iceberg/ws/out.txt
object\oliver
```

That is the whole trick, and it is worth sitting with because it generalizes far past this box. When you control execution but not the channel back, you decouple the two. Run the command, park the result somewhere the target already lets you read, and pick it up separately. It is a dead drop. The spy never hands you the documents. They leave them in a hollow tree, and you collect them on your own walk.

## 0x03 · the safe and its key in the same drawer

Running as the Jenkins service, you go after what Jenkins always hoards, stored credentials. Jenkins encrypts the passwords it saves, but here is the thing about a program that has to use a password automatically: it must be able to decrypt it without a human, which means the decryption key has to live right next to the locked data. Three files matter, and you exfil all of them the same dead-drop way. `credentials.xml` holds the encrypted secret. `master.key` and `hudson.util.Secret` are the key and the unlocking material Jenkins uses on itself.

Think of it like a wall safe with a brilliant combination lock, mounted directly above a drawer, and in that drawer sits a card with the combination written on it, because the building's automatic systems need to open the safe at 3am when nobody is around. The lock is strong and completely pointless. You take the encrypted blob and the keys, decrypt it offline with a small script, and out comes a real domain password for the user `oliver`.

```
$ python3 jenkins_decrypt.py master.key hudson.util.Secret credentials.xml
oliver : c1cdfun_d2434
```

## 0x04 · the map of who can hurt whom

Now you hold a genuine Active Directory user, and the rest of Object is not about exploits at all. It is about permissions that were handed out too generously. You collect the domain's structure with BloodHound, a tool that ingests every user, group, and permission and then draws you a graph of attack paths. Think of it like a giant org chart, except the arrows do not mean reports-to, they mean can-take-over.

BloodHound lights up a chain. `oliver` has the right to force-change the password of `smith`. `smith`, in turn, has ownership-level rights over `maria`. And `maria` sits close enough to the top to read the prize. None of these people is an administrator. Each one simply holds one too-powerful permission over the next, and strung together they form a ladder.

## 0x05 · the relay of borrowed keys

You walk the chain one rung at a time with PowerView, abusing each permission in turn. Because `oliver` can force a password change on `smith`, you set `smith`'s password to one you choose. Now you are `smith`. Because `smith` owns `maria`, you take ownership, grant yourself full control, and reset `maria`'s password too. Now you are `maria`.

```
# as oliver: force-reset smith
Set-DomainUserPassword -Identity smith -AccountPassword $newpw
# as smith: seize maria (own -> grant rights -> reset)
Set-DomainObjectOwner -Identity maria -OwnerIdentity smith
Add-DomainObjectAcl -TargetIdentity maria -PrincipalIdentity smith -Rights All
Set-DomainUserPassword -Identity maria -AccountPassword $newpw
```

It is a relay race where the baton is a password reset. Each runner can only hand off to the exact next person the permissions allow, and you sprint the whole track by being, in sequence, every runner. As `maria` you finally have the access the box was protecting, and `root.txt` is readable.

```
*Evil-WinRM* PS object\maria> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Object only has one actual software trick, the workspace dead drop, and even that is a feature used creatively rather than a bug. Everything after it is misplaced trust, which is what makes it a good teacher. The firewall did its job perfectly and still lost, because blocking outbound traffic does not block an attacker who never needed to leave, it only forces a quieter method. Defenders lean on egress filtering like a wall, when it is really just a tax that pushes attackers toward dead drops and DNS and other patient channels.

The bigger lesson is the permission chain. No single grant on Object looks alarming on its own. Letting one helpdesk-flavored account reset another's password seems fine. Letting a manager own a subordinate's object seems fine. The danger is never the single edge, it is the path, and humans are terrible at seeing paths in a graph of thousands of permissions. That is exactly why attackers run BloodHound and most defenders do not. The fix is to look at your own domain the way an attacker does, as a map of who can become whom, and then cut the edges that chain into a ladder.

## 0x07 · outro

```
the build server ran your command and could not call home,
so you had it leave the answer under the door.
the safe was strong and its key was in the next drawer.
no one was an admin, but each could reset the next,
and a chain of small permissions is a staircase.

control without a channel is still control. find the dead drop.

read the graph, not the grant. cut the path. wear black.

                                                            EOF
```

---

*HTB: Object, a hard Windows box. A masterclass in working without a callback channel, then a clean lesson that Active Directory danger lives in the path, not the permission. Retirement date is a rough marker until verified.*
