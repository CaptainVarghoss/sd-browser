# Stable Diffusion Image Browser

A standalone image browser (not a webui extension) made with Node and SvelteKit.

## Installation

1) Install latest version of Node.js
2) Clone or download the project.
3) Copy the `.env.example` file and rename it to `.env`
4) Set `IMG_FOLDER` to the output folder of stable diffusion (or any other folder containing images)
5) Run command `npm run setup` using command line in the project root folder
6) Run command `npm start` to start the application
7) Open `localhost:[PORT]` in your browser (default `PORT` is `4200`)

## Notes

Authentication hasn't been fully implemented. Keep `PASS` env variable as the default value.

Subfolders under `IMG_FOLDER` are supported, but setting multiple source folders is currently not supported.

# Usage
## Searching

Default search settings use Regex matching and keywords. All searching is case insensitive.

By default, all matches are performed on the positive prompt only. This can be modified by keywords.

The current version supports 3 matching modes:
- Regex: powerful text matching syntax (recommended)
- Words: Matches given words in any order
- Contains: Matches the given value anywhere in the prompt

### Examples (Regex)
Search `red` matches `scarred` and `a red cap`  
Search `\bred\b` matches `a red cap` and `(red)` but not `scarred` (\b is a word boundary character)  
Search `PARAMS steps: (1|2)` matches images that used steps in the range of `1, 2, 10-29, 100-299`.

### Examples (Words)
Search `cute girl` matches `cute, girl` and `girl, ..., cute`, but does not match `cuteness`
Search `red` matches `a red cap` and `(red) cap` but not `scarred`

### Examples (Contains)
Search `cute girl` matches `a cute girl` but not `cute, girl`  
Search `red` matches `scarred`

## Keywords

Available searching keywords are `AND, NOT, ALL, NEGATIVE | NEG, FOLDER | FD, PARAMS | PR`. Keywords must always be upper case. Keywords can be in any order (except AND). Both are valid: `NOT FOLDER img2img` and `FOLDER NOT img2img`.

`AND`: Specify multiple conditions that all have to match  
Example: `red hair AND man`

`NOT`: Inverts a condition  
Example: `red hair AND NOT girl`

`NEG`: Condition matches negative prompt  
Example: `painting AND NEG landscape`

`PARAMS`: Condition matches parameter portion of prompt (Sampler: xxx, etc.)  
Example: `landscape AND PARAMS sampler: euler a`

`FOLDER`: Matches the subfolder the image is located in  
Example: `FOLDER txt2img` or `landscape AND NOT FD img2img|grid`

`ALL`: Condition matches whole prompt (and folder name) instead of only the positive  
Example: `red hair AND NOT ALL girl|boy` (girl or boy not mentioned in any part of the prompt)

## Flyout sidebar

You can use the flyout to embed the stable diffusion webui, so you can use it seamlessly without switching tabs/applications on mobile.
You can change the url of the webui in the settings if necessary.

## Mobile

Optimized for both desktop and mobile use.

The image browser has been setup as PWA compatible, so you can set it on your homescreen on mobile to open it in fullscreen (without a url bar).