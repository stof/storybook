import global from 'global';
import { toId, sanitize } from '@storybook/csf';
import {
  STORY_PREPARED,
  UPDATE_STORY_ARGS,
  RESET_STORY_ARGS,
  STORY_ARGS_UPDATED,
  STORY_CHANGED,
  SELECT_STORY,
  SET_STORIES,
  STORY_SPECIFIED,
} from '@storybook/core-events';
import deprecate from 'util-deprecate';
import { logger } from '@storybook/client-logger';

import { getEventMetadata } from '../lib/events';
import {
  denormalizeStoryParameters,
  transformStoriesRawToStoriesHash,
  isStory,
  isRoot,
  transformStoryIndexToStoriesHash,
} from '../lib/stories';
import type {
  StoriesHash,
  Story,
  Group,
  StoryId,
  Root,
  StoriesRaw,
  SetStoriesPayload,
  StoryIndex,
} from '../lib/stories';

import { Args, ModuleFn } from '../index';
import { ComposedRef } from './refs';

const { DOCS_MODE } = global;

type Direction = -1 | 1;
type ParameterName = string;

type ViewMode = 'story' | 'info' | 'settings' | string | undefined;
type StoryUpdate = Pick<Story, 'parameters' | 'initialArgs' | 'argTypes' | 'args'>;

export interface SubState {
  storiesHash: StoriesHash;
  storyId: StoryId;
  viewMode: ViewMode;
  storiesConfigured: boolean;
  storiesFailed?: Error;
}

export interface SubAPI {
  storyId: typeof toId;
  resolveStory: (storyId: StoryId, refsId?: string) => Story | Group | Root;
  selectFirstStory: () => void;
  selectStory: (
    kindOrId: string,
    story?: string,
    obj?: { ref?: string; viewMode?: ViewMode }
  ) => void;
  getCurrentStoryData: () => Story | Group;
  setStories: (stories: StoriesRaw, failed?: Error) => Promise<void>;
  jumpToComponent: (direction: Direction) => void;
  jumpToStory: (direction: Direction) => void;
  getData: (storyId: StoryId, refId?: string) => Story | Group;
  isPrepared: (storyId: StoryId, refId?: string) => boolean;
  getParameters: (
    storyId: StoryId | { storyId: StoryId; refId: string },
    parameterName?: ParameterName
  ) => Story['parameters'] | any;
  getCurrentParameter<S>(parameterName?: ParameterName): S;
  updateStoryArgs(story: Story, newArgs: Args): void;
  resetStoryArgs: (story: Story, argNames?: string[]) => void;
  findLeafStoryId(StoriesHash: StoriesHash, storyId: StoryId): StoryId;
  fetchStoryList: () => Promise<void>;
  setStoryList: (storyList: StoryIndex) => Promise<void>;
  updateStory: (storyId: StoryId, update: StoryUpdate, ref?: ComposedRef) => Promise<void>;
}

interface Meta {
  ref?: ComposedRef;
  source?: string;
  sourceType?: 'local' | 'external';
  sourceLocation?: string;
  refId?: string;
  v?: number;
  type: string;
}

const deprecatedOptionsParameterWarnings: Record<string, () => void> = [
  'enableShortcuts',
  'theme',
  'showRoots',
].reduce((acc, option: string) => {
  acc[option] = deprecate(
    () => {},
    `parameters.options.${option} is deprecated and will be removed in Storybook 7.0.
To change this setting, use \`addons.setConfig\`. See https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#deprecated-immutable-options-parameters
  `
  );
  return acc;
}, {} as Record<string, () => void>);
function checkDeprecatedOptionParameters(options?: Record<string, any>) {
  if (!options) {
    return;
  }
  Object.keys(options).forEach((option: string) => {
    if (deprecatedOptionsParameterWarnings[option]) {
      deprecatedOptionsParameterWarnings[option]();
    }
  });
}

export const init: ModuleFn = ({
  fullAPI,
  store,
  navigate,
  provider,
  storyId: initialStoryId,
  viewMode: initialViewMode,
}) => {
  const api: SubAPI = {
    storyId: toId,
    getData: (storyId, refId) => {
      const result = api.resolveStory(storyId, refId);

      return isRoot(result) ? undefined : result;
    },
    isPrepared: (storyId, refId) => {
      const data = api.getData(storyId, refId);
      if (data.isLeaf) {
        return data.prepared;
      }
      // Groups are always prepared :shrug:
      return true;
    },
    resolveStory: (storyId, refId) => {
      const { refs, storiesHash } = store.getState();
      if (refId) {
        return refs[refId].stories ? refs[refId].stories[storyId] : undefined;
      }
      return storiesHash ? storiesHash[storyId] : undefined;
    },
    getCurrentStoryData: () => {
      const { storyId, refId } = store.getState();

      return api.getData(storyId, refId);
    },
    getParameters: (storyIdOrCombo, parameterName) => {
      const { storyId, refId } =
        typeof storyIdOrCombo === 'string'
          ? { storyId: storyIdOrCombo, refId: undefined }
          : storyIdOrCombo;
      const data = api.getData(storyId, refId);

      if (isStory(data)) {
        const { parameters } = data;

        if (parameters) {
          return parameterName ? parameters[parameterName] : parameters;
        }

        return {};
      }

      return null;
    },
    getCurrentParameter: (parameterName) => {
      const { storyId, refId } = store.getState();
      const parameters = api.getParameters({ storyId, refId }, parameterName);
      // FIXME Returning falsey parameters breaks a bunch of toolbars code,
      // so this strange logic needs to be here until various client code is updated.
      return parameters || undefined;
    },
    jumpToComponent: (direction) => {
      const { storiesHash, storyId, refs, refId } = store.getState();
      const story = api.getData(storyId, refId);

      // cannot navigate when there's no current selection
      if (!story) {
        return;
      }

      const hash = refId ? refs[refId].stories || {} : storiesHash;

      const lookupList = Object.entries(hash).reduce((acc, i) => {
        const value = i[1];
        if (value.isComponent) {
          acc.push([...i[1].children]);
        }
        return acc;
      }, []);

      const index = lookupList.findIndex((i) => i.includes(storyId));

      // cannot navigate beyond fist or last
      if (index === lookupList.length - 1 && direction > 0) {
        return;
      }
      if (index === 0 && direction < 0) {
        return;
      }

      const result = lookupList[index + direction][0];

      if (result) {
        api.selectStory(result, undefined, { ref: refId });
      }
    },
    jumpToStory: (direction) => {
      const { storiesHash, storyId, refs, refId } = store.getState();
      const story = api.getData(storyId, refId);

      if (DOCS_MODE) {
        api.jumpToComponent(direction);
        return;
      }

      // cannot navigate when there's no current selection
      if (!story) {
        return;
      }

      const hash = story.refId ? refs[story.refId].stories : storiesHash;

      const lookupList = Object.keys(hash).filter(
        (k) => !(hash[k].children || Array.isArray(hash[k]))
      );
      const index = lookupList.indexOf(storyId);

      // cannot navigate beyond fist or last
      if (index === lookupList.length - 1 && direction > 0) {
        return;
      }
      if (index === 0 && direction < 0) {
        return;
      }

      const result = lookupList[index + direction];

      if (result) {
        api.selectStory(result, undefined, { ref: refId });
      }
    },
    setStories: async (input, error) => {
      // Now create storiesHash by reordering the above by group
      const hash = transformStoriesRawToStoriesHash(input, {
        provider,
      });

      await store.setState({
        storiesHash: hash,
        storiesConfigured: true,
        storiesFailed: error,
      });
    },
    selectFirstStory: () => {
      const { storiesHash } = store.getState();
      const firstStory = Object.keys(storiesHash).find(
        (k) => !(storiesHash[k].children || Array.isArray(storiesHash[k]))
      );

      if (firstStory) {
        api.selectStory(firstStory);
        return;
      }

      navigate('/');
    },
    selectStory: (kindOrId, story = undefined, options = {}) => {
      const { ref, viewMode: viewModeFromArgs } = options;
      const {
        viewMode: viewModeFromState = 'story',
        storyId,
        storiesHash,
        refs,
      } = store.getState();

      const hash = ref ? refs[ref].stories : storiesHash;

      if (!story) {
        const s = hash[kindOrId] || hash[sanitize(kindOrId)];
        // eslint-disable-next-line no-nested-ternary
        const id = s ? (s.children ? s.children[0] : s.id) : kindOrId;
        let viewMode =
          s && !isRoot(s) && (viewModeFromArgs || s.parameters.viewMode)
            ? s.parameters.viewMode
            : viewModeFromState;

        // In some cases, the viewMode could be something other than docs/story
        // ('settings', for example) and therefore we should make sure we go back
        // to the 'story' viewMode when navigating away from those pages.
        if (!viewMode.match(/docs|story/)) {
          viewMode = 'story';
        }

        const p = s && s.refId ? `/${viewMode}/${s.refId}_${id}` : `/${viewMode}/${id}`;

        navigate(p);
      } else if (!kindOrId) {
        // This is a slugified version of the kind, but that's OK, our toId function is idempotent
        const kind = storyId.split('--', 2)[0];
        const id = toId(kind, story);

        api.selectStory(id, undefined, options);
      } else {
        const id = ref ? `${ref}_${toId(kindOrId, story)}` : toId(kindOrId, story);
        if (hash[id]) {
          api.selectStory(id, undefined, options);
        } else {
          // Support legacy API with component permalinks, where kind is `x/y` but permalink is 'z'
          const k = hash[sanitize(kindOrId)];
          if (k && k.children) {
            const foundId = k.children.find((childId) => hash[childId].name === story);
            if (foundId) {
              api.selectStory(foundId, undefined, options);
            }
          }
        }
      }
    },
    findLeafStoryId(storiesHash, storyId) {
      if (storiesHash[storyId].isLeaf) {
        return storyId;
      }

      const childStoryId = storiesHash[storyId].children[0];
      return api.findLeafStoryId(storiesHash, childStoryId);
    },
    updateStoryArgs: (story, updatedArgs) => {
      const { id: storyId, refId } = story;
      fullAPI.emit(UPDATE_STORY_ARGS, {
        storyId,
        updatedArgs,
        options: {
          target: refId ? `storybook-ref-${refId}` : 'storybook-preview-iframe',
        },
      });
    },
    resetStoryArgs: (story, argNames?: [string]) => {
      const { id: storyId, refId } = story;
      fullAPI.emit(RESET_STORY_ARGS, {
        storyId,
        argNames,
        options: {
          target: refId ? `storybook-ref-${refId}` : 'storybook-preview-iframe',
        },
      });
    },
    fetchStoryList: async () => {
      // This needs some fleshing out as part of the stories list server project
      const result = await global.fetch('./stories.json');
      const storyIndex = (await result.json()) as StoryIndex;

      // We can only do this if the stories.json is a proper storyIndex
      if (storyIndex.v !== 3) {
        logger.warn(`Skipping story index with version v${storyIndex.v}, awaiting SET_STORIES.`);
        return;
      }

      await fullAPI.setStoryList(storyIndex);
    },
    setStoryList: async (storyIndex: StoryIndex) => {
      const hash = transformStoryIndexToStoriesHash(storyIndex, {
        provider,
      });

      await store.setState({
        storiesHash: hash,
        storiesConfigured: true,
        storiesFailed: null,
      });
    },
    updateStory: async (
      storyId: StoryId,
      update: StoryUpdate,
      ref?: ComposedRef
    ): Promise<void> => {
      if (!ref) {
        const { storiesHash } = store.getState();
        storiesHash[storyId] = {
          ...storiesHash[storyId],
          ...update,
        } as Story;
        await store.setState({ storiesHash });
      } else {
        const { id: refId, stories } = ref;
        stories[storyId] = {
          ...stories[storyId],
          ...update,
        } as Story;
        await fullAPI.updateRef(refId, { stories });
      }
    },
  };

  const initModule = async () => {
    // On initial load, the local iframe will select the first story (or other "selection specifier")
    // and emit STORY_SPECIFIED with the id. We need to ensure we respond to this change.
    fullAPI.on(
      STORY_SPECIFIED,
      function handler({
        storyId,
        viewMode,
      }: {
        storyId: string;
        viewMode: ViewMode;
        [k: string]: any;
      }) {
        const { sourceType } = getEventMetadata(this, fullAPI);

        if (fullAPI.isSettingsScreenActive()) return;

        if (sourceType === 'local') {
          // Special case -- if we are already at the story being specified (i.e. the user started at a given story),
          // we don't need to change URL. See https://github.com/storybookjs/storybook/issues/11677
          const state = store.getState();
          if (state.storyId !== storyId || state.viewMode !== viewMode) {
            navigate(`/${viewMode}/${storyId}`);
          }
        }
      }
    );

    fullAPI.on(STORY_CHANGED, function handler() {
      const { sourceType } = getEventMetadata(this, fullAPI);

      if (sourceType === 'local') {
        const options = fullAPI.getCurrentParameter('options');

        if (options) {
          checkDeprecatedOptionParameters(options);
          fullAPI.setOptions(options);
        }
      }
    });

    fullAPI.on(SET_STORIES, function handler(data: SetStoriesPayload) {
      const { ref } = getEventMetadata(this, fullAPI);
      const stories = data.v ? denormalizeStoryParameters(data) : data.stories;

      if (!ref) {
        if (!data.v) {
          throw new Error('Unexpected legacy SET_STORIES event from local source');
        }

        fullAPI.setStories(stories);
        const options = fullAPI.getCurrentParameter('options');
        checkDeprecatedOptionParameters(options);
        fullAPI.setOptions(options);
      } else {
        fullAPI.setRef(ref.id, { ...ref, ...data, stories }, true);
      }
    });

    fullAPI.on(
      SELECT_STORY,
      function handler({
        kind,
        story,
        ...rest
      }: {
        kind: string;
        story: string;
        viewMode: ViewMode;
      }) {
        const { ref } = getEventMetadata(this, fullAPI);

        if (!ref) {
          fullAPI.selectStory(kind, story, rest);
        } else {
          fullAPI.selectStory(kind, story, { ...rest, ref: ref.id });
        }
      }
    );

    fullAPI.on(STORY_PREPARED, function handler({ id, ...update }) {
      const { ref } = getEventMetadata(this, fullAPI);
      fullAPI.updateStory(id, { ...update, prepared: true }, ref);

      if (!store.getState().hasCalledSetOptions) {
        const { options } = update.parameters;
        checkDeprecatedOptionParameters(options);
        fullAPI.setOptions(options);
        store.setState({ hasCalledSetOptions: true });
      }
    });

    fullAPI.on(
      STORY_ARGS_UPDATED,
      function handleStoryArgsUpdated({ storyId, args }: { storyId: StoryId; args: Args }) {
        const { ref } = getEventMetadata(this, fullAPI);
        fullAPI.updateStory(storyId, { args }, ref);
      }
    );

    await fullAPI.fetchStoryList();
  };

  return {
    api,
    state: {
      storiesHash: {},
      storyId: initialStoryId,
      viewMode: initialViewMode,
      storiesConfigured: false,
      hasCalledSetOptions: false,
    },
    init: initModule,
  };
};
