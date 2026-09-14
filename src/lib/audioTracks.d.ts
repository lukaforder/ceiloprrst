interface AudioTrack {
	id: string;
	kind: string;
	label: string;
	language: string;
	enabled: boolean;
}

interface AudioTrackList extends EventTarget {
	readonly length: number;
	[index: number]: AudioTrack;
	onaddtrack: ((this: AudioTrackList, ev: Event) => unknown) | null;
	onremovetrack: ((this: AudioTrackList, ev: Event) => unknown) | null;
	onchange: ((this: AudioTrackList, ev: Event) => unknown) | null;
}

interface HTMLMediaElement {
	readonly audioTracks?: AudioTrackList;
}
