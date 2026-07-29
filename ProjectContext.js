// Central data store. All state lives on-device (AsyncStorage for metadata,
// app document directory + user's photo library for media). Zero servers.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'mepsurvey.projects.v1';
const SKEY = 'mepsurvey.settings.v1';
const Ctx = createContext(null);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState({ firmName: '', logoUri: null });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((s) => setProjects(s ? JSON.parse(s) : []))
      .catch(() => setProjects([]))
      .finally(() => setLoaded(true));
    AsyncStorage.getItem(SKEY)
      .then((s) => { if (s) setSettings(JSON.parse(s)); })
      .catch(() => {});
  }, []);

  const persist = useCallback((next) => {
    setProjects(next);
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const createProject = useCallback((p) => {
    const proj = {
      id: uid(),
      createdAt: new Date().toISOString(),
      photos: [],   // {id, uri, assetId, level, space, spaceNum, system, mode, caption, flagged, quality, nameplate:{...}|null, takenAt, type:'photo'|'video'}
      panels: [],   // {id, panelId, voltage, busAmps, main, location, schedulePhoto, leftPhotos:[], rightPhotos:[]}
      measurements: [], // {id, kind:'pipe'|'duct', label, calcOD, insulation, distanceM, at}
      ...p,
    };
    persist([proj, ...projects]);
    return proj.id;
  }, [projects, persist]);

  const updateProject = useCallback((id, patch) => {
    persist(projects.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, [projects, persist]);

  const addPhoto = useCallback((projectId, photo) => {
    const id = uid();
    persist(projects.map((p) =>
      p.id === projectId ? { ...p, photos: [...p.photos, { id, takenAt: new Date().toISOString(), ...photo }] } : p
    ));
    return id;
  }, [projects, persist]);

  const updatePhoto = useCallback((projectId, photoId, patch) => {
    persist(projects.map((p) =>
      p.id === projectId
        ? { ...p, photos: p.photos.map((ph) => (ph.id === photoId ? { ...ph, ...patch } : ph)) }
        : p
    ));
  }, [projects, persist]);

  // Batch version of updatePhoto: applies a patch (or a per-photo patch via
  // a function) to many photos in ONE persist/write, used by the Finalize
  // review screen for bulk tagging and bulk room reassignment. Looping
  // single updatePhoto calls would read-modify-write AsyncStorage once per
  // photo, which is both slower and drops updates if called in a tight loop
  // (each call captures a stale `projects` snapshot).
  const updatePhotos = useCallback((projectId, photoIds, patchOrFn) => {
    const idSet = new Set(photoIds);
    persist(projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            photos: p.photos.map((ph) => {
              if (!idSet.has(ph.id)) return ph;
              const patch = typeof patchOrFn === 'function' ? patchOrFn(ph) : patchOrFn;
              return { ...ph, ...patch };
            }),
          }
        : p
    ));
  }, [projects, persist]);

  const deletePhoto = useCallback((projectId, photoId) => {
    persist(projects.map((p) =>
      p.id === projectId ? { ...p, photos: p.photos.filter((ph) => ph.id !== photoId) } : p
    ));
  }, [projects, persist]);

  // Batch delete, same rationale as updatePhotos.
  const deletePhotos = useCallback((projectId, photoIds) => {
    const idSet = new Set(photoIds);
    persist(projects.map((p) =>
      p.id === projectId ? { ...p, photos: p.photos.filter((ph) => !idSet.has(ph.id)) } : p
    ));
  }, [projects, persist]);

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(SKEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const addMeasurement = useCallback((projectId, m) => {
    persist(projects.map((p) =>
      p.id === projectId
        ? { ...p, measurements: [...(p.measurements || []), { id: uid(), at: new Date().toISOString(), ...m }] }
        : p
    ));
  }, [projects, persist]);

  // Nameplate data lives on photo.nameplate (set by CameraScreen or Decoder,
  // both saving through addPhoto). No separate equipment store — see
  // DecoderScreen and EquipmentScreen for why.

  const addPanel = useCallback((projectId, panel) => {
    const id = uid();
    persist(projects.map((p) =>
      p.id === projectId ? { ...p, panels: [...p.panels, { id, leftPhotos: [], rightPhotos: [], ...panel }] } : p
    ));
    return id;
  }, [projects, persist]);

  const updatePanel = useCallback((projectId, panelId, patch) => {
    persist(projects.map((p) =>
      p.id === projectId
        ? { ...p, panels: p.panels.map((pn) => (pn.id === panelId ? { ...pn, ...patch } : pn)) }
        : p
    ));
  }, [projects, persist]);

  const deleteProject = useCallback((id) => {
    persist(projects.filter((p) => p.id !== id));
  }, [projects, persist]);

  return (
    <Ctx.Provider value={{
      loaded, projects,
      createProject, updateProject, deleteProject,
      addPhoto, updatePhoto, updatePhotos, deletePhoto, deletePhotos,
      addPanel, updatePanel, addMeasurement,
      settings, updateSettings,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useProjects = () => useContext(Ctx);
